package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Plugin Views — plugins can register top-bar menu items that open a
// sheet rendering a list/object backed by JSON files. Three pieces:
//
//   1. menu_items declared in <plugin>/.claude-plugin/config.json
//   2. data source: a glob of JSON files under one of the orch's roots
//      (claude_dir, cwd, library) with a shape (file-per-item or
//      merged-list). The runtime reads/lists/patches/deletes those
//      files via these endpoints.
//   3. template: an HTML file shipped in the plugin (served via the
//      plugin-asset endpoint) — the React panel iframes it after
//      injecting data + action wiring.
//
// All file paths the user can supply (glob, root) are clamped to the
// orch's tree. Path-traversal escapes are rejected.

// ---------- spec types --------------------------------------------------

// menuItem is one entry under a plugin's config.json `menu_items`.
type menuItem struct {
	ID         string         `json:"id"`
	Label      string         `json:"label"`
	Icon       string         `json:"icon,omitempty"`
	AgentKinds []string       `json:"agent_kinds,omitempty"`
	Data       menuDataSource `json:"data"`
	Template   string         `json:"template,omitempty"`
	// Plugin/marketplace are filled in by the loader, not the file.
	Plugin      string `json:"plugin,omitempty"`
	Marketplace string `json:"marketplace,omitempty"`
}

type menuDataSource struct {
	// kind: "file-per-item" or "merged-list"
	Kind string `json:"kind"`
	// root: "claude_dir" | "cwd" | "library"
	Root string `json:"root"`
	// glob (relative to root)
	Glob string `json:"glob"`
	// id field in each item; defaults to "id" (or filename stem in
	// file-per-item mode if the field is absent in the JSON)
	IDField string `json:"id_field,omitempty"`
	// only used in merged-list mode: file new items get appended to
	DefaultFile string `json:"default_file,omitempty"`
}

func (s menuDataSource) idField() string {
	if s.IDField == "" {
		return "id"
	}
	return s.IDField
}

// pluginConfig is the subset of config.json this file cares about.
// Other fields (credentials, schedules, setup_scripts) are read
// elsewhere; we only deserialize menu_items here.
type pluginConfig struct {
	MenuItems []menuItem `json:"menu_items,omitempty"`
}

// ---------- root resolution --------------------------------------------

// agentClaudeDir wraps effectiveClaudeDir(a, all) for callers that
// only have an agent id. Returns ("", nil) when the agent has no
// resolvable claude dir (dispatcher with no per-orch isolation, etc).
func agentClaudeDir(agentID string) (string, error) {
	all, err := loadAllAgents()
	if err != nil {
		return "", err
	}
	for i := range all {
		if all[i].ID == agentID {
			dir, _, _ := effectiveClaudeDir(all[i], all)
			return dir, nil
		}
	}
	return "", fmt.Errorf("no such agent")
}

// resolveRoot maps a `root` keyword to an absolute path for the agent.
// claude_dir → effective CLAUDE_CONFIG_DIR (may be inherited via the
//   parent for workers — same logic as plugin install/list)
// cwd       → the orch's space dir (or its orch ancestor's, for workers)
// library   → cwd + "/library"
func resolveRoot(root string, agentID string) (string, error) {
	switch root {
	case "claude_dir", "":
		dir, err := agentClaudeDir(agentID)
		if err != nil {
			return "", err
		}
		if dir == "" {
			return "", fmt.Errorf("agent has no claude config dir")
		}
		return dir, nil
	case "cwd":
		return agentCwd(agentID)
	case "library":
		// orchSpaceDir already returns <cwd>/library/.
		return orchSpaceDir(agentID)
	}
	return "", fmt.Errorf("unknown data root %q (want claude_dir|cwd|library)", root)
}

// safeGlob refuses globs that contain absolute paths or `..` segments.
// Plugin authors describe paths relative to a chosen root; anything
// trying to escape is rejected here.
func safeGlob(g string) error {
	if g == "" {
		return fmt.Errorf("glob is empty")
	}
	if filepath.IsAbs(g) {
		return fmt.Errorf("glob must be relative")
	}
	for _, seg := range strings.Split(g, "/") {
		if seg == ".." {
			return fmt.Errorf("glob may not contain ..")
		}
	}
	return nil
}

// ---------- menu items aggregation -------------------------------------

// loadMenuItems walks the agent's installed plugins and merges their
// config.json menu_items lists, filtering by agent_kinds when set.
func loadMenuItems(agentID string) ([]menuItem, error) {
	dir, err := agentClaudeDir(agentID)
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return nil, nil
	}
	all, err := loadAllAgents()
	if err != nil {
		return nil, err
	}
	var kind string
	for _, a := range all {
		if a.ID == agentID {
			kind = a.Kind
			break
		}
	}

	ipPath := filepath.Join(dir, "plugins", "installed_plugins.json")
	b, err := os.ReadFile(ipPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var ip struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(b, &ip); err != nil {
		return nil, err
	}
	var out []menuItem
	for key, entries := range ip.Plugins {
		if len(entries) == 0 {
			continue
		}
		pluginName, marketplace := splitMenuPluginKey(key)
		install := entries[0].InstallPath
		cfgPath := filepath.Join(install, ".claude-plugin", "config.json")
		cb, err := os.ReadFile(cfgPath)
		if err != nil {
			continue
		}
		var cfg pluginConfig
		if err := json.Unmarshal(cb, &cfg); err != nil {
			continue
		}
		for _, mi := range cfg.MenuItems {
			if !kindMatches(mi.AgentKinds, kind) {
				continue
			}
			mi.Plugin = pluginName
			mi.Marketplace = marketplace
			out = append(out, mi)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Label != out[j].Label {
			return strings.ToLower(out[i].Label) < strings.ToLower(out[j].Label)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func kindMatches(allowed []string, kind string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, k := range allowed {
		if k == kind {
			return true
		}
	}
	return false
}

func splitMenuPluginKey(key string) (string, string) {
	i := strings.LastIndex(key, "@")
	if i <= 0 {
		return key, ""
	}
	return key[:i], key[i+1:]
}

// resolveMenuItem looks up a menu item by (plugin, id). The agent's
// installed plugins are searched. Returns the item and the plugin's
// install dir (used for serving template assets).
func resolveMenuItem(agentID, plugin, menuID string) (menuItem, string, error) {
	dir, err := agentClaudeDir(agentID)
	if err != nil {
		return menuItem{}, "", err
	}
	ipPath := filepath.Join(dir, "plugins", "installed_plugins.json")
	b, err := os.ReadFile(ipPath)
	if err != nil {
		return menuItem{}, "", err
	}
	var ip struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(b, &ip); err != nil {
		return menuItem{}, "", err
	}
	for key, entries := range ip.Plugins {
		if len(entries) == 0 {
			continue
		}
		pName, _ := splitMenuPluginKey(key)
		if pName != plugin {
			continue
		}
		install := entries[0].InstallPath
		cb, err := os.ReadFile(filepath.Join(install, ".claude-plugin", "config.json"))
		if err != nil {
			continue
		}
		var cfg pluginConfig
		if err := json.Unmarshal(cb, &cfg); err != nil {
			continue
		}
		for _, mi := range cfg.MenuItems {
			if mi.ID == menuID {
				mi.Plugin = pName
				return mi, install, nil
			}
		}
	}
	return menuItem{}, "", fmt.Errorf("menu item %s/%s not found", plugin, menuID)
}

// ---------- data source read/write -------------------------------------

// dataItem is one entry returned to the UI. The runtime adds two
// metadata fields the template can reference but the plugin's source
// JSON shouldn't contain:
//
//   __file: absolute path of the file this item came from
//   __id:   the resolved id (from id_field, or filename stem)
type dataItem map[string]any

func readDataSource(agentID string, src menuDataSource) ([]dataItem, error) {
	if err := safeGlob(src.Glob); err != nil {
		return nil, err
	}
	root, err := resolveRoot(src.Root, agentID)
	if err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(root, src.Glob))
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	var items []dataItem
	switch src.Kind {
	case "file-per-item":
		for _, m := range matches {
			if !isWithin(root, m) {
				continue
			}
			b, err := os.ReadFile(m)
			if err != nil {
				continue
			}
			var v dataItem
			if err := json.Unmarshal(b, &v); err != nil {
				continue
			}
			if v == nil {
				v = dataItem{}
			}
			v["__file"] = m
			v["__id"] = itemID(v, src, m)
			items = append(items, v)
		}
	case "merged-list":
		for _, m := range matches {
			if !isWithin(root, m) {
				continue
			}
			b, err := os.ReadFile(m)
			if err != nil {
				continue
			}
			var arr []dataItem
			if err := json.Unmarshal(b, &arr); err != nil {
				continue
			}
			for _, v := range arr {
				if v == nil {
					v = dataItem{}
				}
				v["__file"] = m
				v["__id"] = itemID(v, src, "")
				items = append(items, v)
			}
		}
	default:
		return nil, fmt.Errorf("unknown data kind %q", src.Kind)
	}
	return items, nil
}

func itemID(v dataItem, src menuDataSource, fallbackFile string) string {
	if id, ok := v[src.idField()]; ok {
		switch t := id.(type) {
		case string:
			return t
		case float64:
			return fmt.Sprintf("%v", t)
		}
	}
	if fallbackFile == "" {
		return ""
	}
	base := filepath.Base(fallbackFile)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// patchDataItem updates fields on the matching item in the source. For
// file-per-item, it rewrites the matching file; for merged-list, it
// rewrites the file the item came from.
func patchDataItem(agentID string, src menuDataSource, itemIDStr string, patch map[string]any) error {
	items, err := readDataSource(agentID, src)
	if err != nil {
		return err
	}
	var target dataItem
	for _, v := range items {
		if v["__id"] == itemIDStr {
			target = v
			break
		}
	}
	if target == nil {
		return fmt.Errorf("item %q not found", itemIDStr)
	}
	file := target["__file"].(string)
	switch src.Kind {
	case "file-per-item":
		// Patch in place; rewrite the file. Drop the __ metadata so we
		// don't write our internal additions back to disk.
		for k, v := range patch {
			target[k] = v
		}
		clean := dataItem{}
		for k, v := range target {
			if !strings.HasPrefix(k, "__") {
				clean[k] = v
			}
		}
		return writeJSONFile(file, clean)
	case "merged-list":
		// Read the file as an array, find by id, rewrite.
		b, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var arr []dataItem
		if err := json.Unmarshal(b, &arr); err != nil {
			return err
		}
		for i, v := range arr {
			if v == nil {
				continue
			}
			if itemID(v, src, "") == itemIDStr {
				for k, val := range patch {
					arr[i][k] = val
				}
				return writeJSONFile(file, arr)
			}
		}
		return fmt.Errorf("item %q not in %s", itemIDStr, file)
	}
	return fmt.Errorf("unknown kind %q", src.Kind)
}

// addDataItem creates a new item in the data source. file-per-item
// writes to <root>/<dir>/<id>.json — the dir is derived from the
// glob's first wildcarded segment so we land somewhere the read path
// will discover. `fields` is the user-supplied payload; we generate
// an id and timestamp, plus default `status: "pending"` for taskish
// payloads.
func addDataItem(agentID string, src menuDataSource, fields map[string]any) (dataItem, error) {
	if src.Kind != "file-per-item" {
		// merged-list create requires picking a parent file; not used
		// by any current plugin and easy to add later.
		return nil, fmt.Errorf("create not supported for kind %q", src.Kind)
	}
	root, err := resolveRoot(src.Root, agentID)
	if err != nil {
		return nil, err
	}

	id, _ := newDataItemID()
	if v, ok := fields["id"].(string); ok && v != "" {
		id = v
	}

	item := dataItem{}
	for k, v := range fields {
		if !strings.HasPrefix(k, "__") {
			item[k] = v
		}
	}
	item["id"] = id
	if _, hasStatus := item["status"]; !hasStatus {
		item["status"] = "pending"
	}
	item["createdAt"] = time.Now().UTC().Format(time.RFC3339)

	dir := writeDirForGlob(root, src.Glob)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, id+".json")
	if err := writeJSONFile(file, item); err != nil {
		return nil, err
	}
	item["__file"] = file
	item["__id"] = id
	return item, nil
}

// writeDirForGlob returns the directory the create handler should
// write into. We walk the glob until we hit a wildcard segment and
// reuse anything before it as a literal subpath; the wildcard itself
// becomes "director-ui" (a stable bucket so UI-created items stay
// discoverable on the next read). Examples:
//   tasks/*/*.json     → <root>/tasks/director-ui
//   schedules/*.json   → <root>/schedules
//   *.json             → <root>
func writeDirForGlob(root, glob string) string {
	parts := strings.Split(glob, "/")
	out := root
	for _, p := range parts {
		if strings.ContainsAny(p, "*?[") {
			// First wildcard: if it's not the leaf (has more after it),
			// substitute "director-ui" so the read glob still picks
			// these up. If it IS the leaf (e.g. `*.json`), stop here.
			break
		}
		out = filepath.Join(out, p)
	}
	// If the glob has the form `<dir>/*/<file-pattern>`, also nest
	// into the director-ui bucket so reads land it.
	if strings.Count(glob, "*") >= 2 {
		out = filepath.Join(out, "director-ui")
	}
	return out
}

// newDataItemID returns a short random id suitable for filename use.
// 16 hex chars (64 bits) is plenty for a per-agent task list.
func newDataItemID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func deleteDataItem(agentID string, src menuDataSource, itemIDStr string) error {
	items, err := readDataSource(agentID, src)
	if err != nil {
		return err
	}
	var target dataItem
	for _, v := range items {
		if v["__id"] == itemIDStr {
			target = v
			break
		}
	}
	if target == nil {
		return fmt.Errorf("item %q not found", itemIDStr)
	}
	file := target["__file"].(string)
	switch src.Kind {
	case "file-per-item":
		return os.Remove(file)
	case "merged-list":
		b, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var arr []dataItem
		if err := json.Unmarshal(b, &arr); err != nil {
			return err
		}
		out := arr[:0]
		for _, v := range arr {
			if itemID(v, src, "") == itemIDStr {
				continue
			}
			out = append(out, v)
		}
		return writeJSONFile(file, out)
	}
	return fmt.Errorf("unknown kind %q", src.Kind)
}

func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// ---------- HTTP handlers ----------------------------------------------

// GET /api/agents/:id/menu-items
func handleMenuItems(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	items, err := loadMenuItems(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []menuItem{}
	}
	writeJSON(w, items)
}

// GET /api/agents/:id/plugin-asset?plugin=tasks&path=ui/tasks.html
// Serves a file from the plugin's install dir. Path-traversal is
// blocked by isWithin.
func handlePluginAsset(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	plugin := r.URL.Query().Get("plugin")
	rel := r.URL.Query().Get("path")
	if plugin == "" || rel == "" {
		http.Error(w, "plugin and path required", http.StatusBadRequest)
		return
	}
	// Find the plugin's install path the same way resolveMenuItem does.
	dir, err := agentClaudeDir(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	ipPath := filepath.Join(dir, "plugins", "installed_plugins.json")
	b, err := os.ReadFile(ipPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	var ip struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(b, &ip); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var install string
	for key, entries := range ip.Plugins {
		if len(entries) == 0 {
			continue
		}
		pName, _ := splitMenuPluginKey(key)
		if pName == plugin {
			install = entries[0].InstallPath
			break
		}
	}
	if install == "" {
		http.Error(w, "plugin not installed", http.StatusNotFound)
		return
	}
	target := filepath.Join(install, rel)
	if !isWithin(install, target) {
		http.Error(w, "path escapes plugin root", http.StatusBadRequest)
		return
	}
	http.ServeFile(w, r, target)
}

// GET    /api/agents/:id/data/<plugin>/<menu-id>          → list items
// PATCH  /api/agents/:id/data/<plugin>/<menu-id>/<item>   → mutate fields
// DELETE /api/agents/:id/data/<plugin>/<menu-id>/<item>   → remove item
func handlePluginData(w http.ResponseWriter, r *http.Request, agentID, tail string) {
	parts := strings.SplitN(strings.TrimPrefix(tail, "/"), "/", 3)
	if len(parts) < 2 {
		http.Error(w, "usage: /data/<plugin>/<menu-id>[/item-id]", http.StatusBadRequest)
		return
	}
	plugin, menuID := parts[0], parts[1]
	mi, _, err := resolveMenuItem(agentID, plugin, menuID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	switch r.Method {
	case http.MethodGet:
		items, err := readDataSource(agentID, mi.Data)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []dataItem{}
		}
		writeJSON(w, items)
	case http.MethodPost:
		// New-item creation. Body is the field set the user wants
		// stored; we generate id + status + createdAt server-side.
		var fields map[string]any
		if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		item, err := addDataItem(agentID, mi.Data, fields)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, item)
	case http.MethodPatch:
		if len(parts) < 3 || parts[2] == "" {
			http.Error(w, "item id required", http.StatusBadRequest)
			return
		}
		var patch map[string]any
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := patchDataItem(agentID, mi.Data, parts[2], patch); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if len(parts) < 3 || parts[2] == "" {
			http.Error(w, "item id required", http.StatusBadRequest)
			return
		}
		if err := deleteDataItem(agentID, mi.Data, parts[2]); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}
