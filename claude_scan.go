package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ClaudeDirView is what the UI sees for one agent's CLAUDE_CONFIG_DIR.
// Source records which agent (if any) actually owns the dir — so the UI
// can show "inherited from <orch>" or "global" where appropriate.
type ClaudeDirView struct {
	Source       string        `json:"source"` // "own" | "inherited" | "global"
	SourceID     string        `json:"source_id,omitempty"`
	Dir          string        `json:"dir"`
	Skills       []Skill       `json:"skills"`
	Agents       []NamedMD     `json:"agents"`
	Commands     []NamedMD     `json:"commands"`
	Plugins      []Plugin      `json:"plugins"`
	Marketplaces []Marketplace `json:"marketplaces"`
	Memory       *MemoryDoc    `json:"memory,omitempty"`
}

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Dir         string `json:"dir"`
	Enabled     bool   `json:"enabled"`
}

type NamedMD struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type MemoryDoc struct {
	Bytes   int64  `json:"bytes"`
	Preview string `json:"preview,omitempty"`
}

// Plugin is a plugin already installed in the agent's .claude dir.
type Plugin struct {
	Name         string                `json:"name"`
	Marketplace  string                `json:"marketplace"`
	Version      string                `json:"version,omitempty"`
	Description  string                `json:"description,omitempty"`
	Author       string                `json:"author,omitempty"`
	Enabled      bool                  `json:"enabled"`
	Credentials  []CredentialDecl      `json:"credentials,omitempty"`
	Schedules    []ScheduleSuggestion  `json:"schedules,omitempty"`
	SetupScripts []SetupScript         `json:"setup_scripts,omitempty"`
}

// ScheduleSuggestion comes from a plugin's .claude-plugin/config.json.
// `Applied` is derived at scan time — true when the orch's
// scheduled_tasks.json already has a task with the same id.
type ScheduleSuggestion struct {
	ID          string `json:"id"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Cron        string `json:"cron"`
	Prompt      string `json:"prompt"`
	Recurring   bool   `json:"recurring,omitempty"`
	Applied     bool   `json:"applied"`
}

// SetupScript is a one-shot bash command shipped with a plugin to
// scaffold whatever the plugin needs (directories, starter files,
// etc.) in the orch's cwd.
type SetupScript struct {
	ID          string `json:"id"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Command     string `json:"command"`
	RunOnce     bool   `json:"run_once,omitempty"`
}

// CredentialDecl comes from a plugin's .claude-plugin/credentials.json.
// `Set` is derived at scan time — whether a value has been saved to the
// user's macOS Keychain for this (agent, plugin, key) tuple.
type CredentialDecl struct {
	Key         string `json:"key"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Set         bool   `json:"set"`
}

// Marketplace lists plugins a user could install. Space-isolated: we only
// surface marketplaces that are registered in THIS agent's .claude dir.
type Marketplace struct {
	Name    string         `json:"name"`
	Source  string         `json:"source,omitempty"`
	Plugins []MarketPlugin `json:"plugins"`
}

type MarketPlugin struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Category    string `json:"category,omitempty"`
	Installed   bool   `json:"installed"`
}

// effectiveClaudeDir mirrors roster's claudeDirFor: orchestrators and
// dispatchers each own a dir under <XDG data>/roster/claude/<id>;
// workers inherit from their nearest orchestrator ancestor; anything
// else falls back to ~/.claude.
func effectiveClaudeDir(a Agent, all []Agent) (dir, source, sourceID string) {
	switch a.Kind {
	case "orchestrator", "dispatcher":
		return orchClaudeDir(a.ID), "own", a.ID
	case "worker":
		orch := findOrchAncestor(a.Parent, all)
		if orch != "" {
			return orchClaudeDir(orch), "inherited", orch
		}
	}
	return globalClaudeDir(), "global", ""
}

func orchClaudeDir(id string) string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		// ROSTER_DIR points at the agents dir itself; its parent holds
		// claude/. Walk up once.
		return filepath.Join(filepath.Dir(d), "claude", id)
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "claude", id)
}

func globalClaudeDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func findOrchAncestor(startID string, all []Agent) string {
	byID := make(map[string]Agent, len(all))
	for _, a := range all {
		byID[a.ID] = a
	}
	cur := startID
	for i := 0; i < 20 && cur != ""; i++ {
		a, ok := byID[cur]
		if !ok {
			return ""
		}
		if a.Kind == "orchestrator" {
			return a.ID
		}
		cur = a.Parent
	}
	return ""
}

// --- scanning --------------------------------------------------------------

func scanClaudeDir(dir, agentID string) (skills []Skill, agents, commands []NamedMD, plugins []Plugin, markets []Marketplace, memory *MemoryDoc) {
	skills = scanSkills(filepath.Join(dir, "skills"))
	agents = scanMDFolder(filepath.Join(dir, "agents"))
	commands = scanMDFolder(filepath.Join(dir, "commands"))
	plugins = scanInstalledPluginsForAgent(dir, agentID)
	markets = scanMarketplaces(dir, plugins)
	memory = readMemory(filepath.Join(dir, "CLAUDE.md"))
	return
}

// --- plugins ---------------------------------------------------------------

// scanInstalledPlugins reads installed_plugins.json + settings.json in dir.
// Returns entries with plugin.json-derived description/author when present.
func scanInstalledPlugins(dir string) []Plugin {
	return scanInstalledPluginsForAgent(dir, "")
}

// scanInstalledPluginsForAgent is the flavor that also populates each
// plugin's credential `set` flag against a keychain scoped to `agentID`.
// Agent id may be empty — then `set` is always false.
func scanInstalledPluginsForAgent(dir, agentID string) []Plugin {
	ipPath := filepath.Join(dir, "plugins", "installed_plugins.json")
	b, err := os.ReadFile(ipPath)
	if err != nil {
		return nil
	}
	var ip struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
			Version     string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(b, &ip); err != nil {
		return nil
	}
	enabled := readEnabledPlugins(dir)
	var out []Plugin
	for key, entries := range ip.Plugins {
		if len(entries) == 0 {
			continue
		}
		name, marketplace := splitPluginKey(key)
		p := Plugin{
			Name:        name,
			Marketplace: marketplace,
			Version:     entries[0].Version,
			Enabled:     enabled[key],
		}
		if meta := readPluginManifest(entries[0].InstallPath); meta != nil {
			p.Description = meta.Description
			p.Author = meta.AuthorName
		}
		p.Credentials, p.Schedules, p.SetupScripts = readPluginConfig(
			entries[0].InstallPath, dir, agentID, p.Name, p.Marketplace,
		)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Enabled != out[j].Enabled {
			return out[i].Enabled
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// splitPluginKey parses "name@marketplace" (marketplace may contain @).
func splitPluginKey(key string) (name, marketplace string) {
	i := strings.LastIndex(key, "@")
	if i <= 0 {
		return key, ""
	}
	return key[:i], key[i+1:]
}

// readEnabledPlugins returns the {"name@mp": true} map from settings.json.
func readEnabledPlugins(dir string) map[string]bool {
	out := map[string]bool{}
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return out
	}
	var s struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return out
	}
	for k, v := range s.EnabledPlugins {
		out[k] = v
	}
	return out
}

type pluginManifest struct {
	Description string
	AuthorName  string
}

func readPluginManifest(installPath string) *pluginManifest {
	if installPath == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(installPath, ".claude-plugin", "plugin.json"))
	if err != nil {
		return nil
	}
	var m struct {
		Description string `json:"description"`
		Author      struct {
			Name string `json:"name"`
		} `json:"author"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil
	}
	return &pluginManifest{Description: m.Description, AuthorName: m.Author.Name}
}

// scanMarketplaces walks plugins/marketplaces/ and returns each registered
// marketplace with its advertised plugins. Claude Code stores these either
// as a cloned repo directory (with .claude-plugin/marketplace.json inside)
// OR as a flat JSON file named for the marketplace — we accept both.
func scanMarketplaces(dir string, installed []Plugin) []Marketplace {
	mpDir := filepath.Join(dir, "plugins", "marketplaces")
	entries, err := os.ReadDir(mpDir)
	if err != nil {
		return nil
	}
	installedKey := map[string]bool{}
	for _, p := range installed {
		installedKey[p.Name+"@"+p.Marketplace] = true
	}
	var out []Marketplace
	for _, e := range entries {
		name := strings.TrimSuffix(e.Name(), ".json")
		mp := loadMarketplace(filepath.Join(mpDir, e.Name()), name, e.IsDir(), installedKey)
		if mp != nil {
			out = append(out, *mp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func loadMarketplace(path, name string, isDir bool, installedKey map[string]bool) *Marketplace {
	var raw []byte
	if isDir {
		for _, cand := range []string{
			filepath.Join(path, ".claude-plugin", "marketplace.json"),
			filepath.Join(path, "marketplace.json"),
		} {
			if b, err := os.ReadFile(cand); err == nil {
				raw = b
				break
			}
		}
	} else {
		if b, err := os.ReadFile(path); err == nil {
			raw = b
		}
	}
	if raw == nil {
		return nil
	}
	var m struct {
		Name    string `json:"name"`
		Source  any    `json:"source"`
		Plugins []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	displayName := m.Name
	if displayName == "" {
		displayName = name
	}
	out := &Marketplace{Name: displayName, Source: sourceToString(m.Source)}
	for _, p := range m.Plugins {
		out.Plugins = append(out.Plugins, MarketPlugin{
			Name:        p.Name,
			Description: p.Description,
			Category:    p.Category,
			Installed:   installedKey[p.Name+"@"+name],
		})
	}
	sort.Slice(out.Plugins, func(i, j int) bool { return out.Plugins[i].Name < out.Plugins[j].Name })
	return out
}

func sourceToString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		if u, ok := x["url"].(string); ok {
			return u
		}
	}
	return ""
}

// scanSkills looks for skill directories, each containing SKILL.md (or
// SKILL.md.disabled). Returns them sorted by name.
func scanSkills(skillsDir string) []Skill {
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return nil
	}
	var out []Skill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		d := filepath.Join(skillsDir, e.Name())
		active := filepath.Join(d, "SKILL.md")
		disabled := filepath.Join(d, "SKILL.md.disabled")
		md := ""
		enabled := false
		if _, err := os.Stat(active); err == nil {
			md, enabled = active, true
		} else if _, err := os.Stat(disabled); err == nil {
			md = disabled
		} else {
			continue
		}
		fm := parseFrontmatter(md)
		name := fm["name"]
		if name == "" {
			name = e.Name()
		}
		out = append(out, Skill{
			Name:        name,
			Description: fm["description"],
			Dir:         d,
			Enabled:     enabled,
		})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// scanMDFolder lists *.md files in dir, pulling an optional description
// from YAML frontmatter.
func scanMDFolder(dir string) []NamedMD {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []NamedMD
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		fm := parseFrontmatter(p)
		name := strings.TrimSuffix(e.Name(), ".md")
		out = append(out, NamedMD{Name: name, Description: fm["description"]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func readMemory(path string) *MemoryDoc {
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return &MemoryDoc{Bytes: fi.Size()}
	}
	preview := strings.TrimSpace(string(b))
	if len(preview) > 240 {
		preview = preview[:240] + "…"
	}
	return &MemoryDoc{Bytes: fi.Size(), Preview: preview}
}

// parseFrontmatter reads the leading `---\n...\n---` block from a file
// and returns its keys as a flat map. Handles quoted scalars and YAML
// folded/literal block scalars (key: >, key: |): subsequent indented
// lines are joined with spaces. Anything fancier collapses to "".
func parseFrontmatter(path string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	s := string(b)
	if !strings.HasPrefix(s, "---\n") {
		return out
	}
	end := strings.Index(s[4:], "\n---")
	if end < 0 {
		return out
	}
	lines := strings.Split(s[4:4+end], "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		colon := strings.Index(line, ":")
		if colon < 0 || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		k := strings.TrimSpace(line[:colon])
		v := strings.TrimSpace(line[colon+1:])
		// Block scalar: gather following indented lines.
		if v == ">" || v == "|" || v == ">-" || v == "|-" {
			var parts []string
			for j := i + 1; j < len(lines); j++ {
				next := lines[j]
				if next == "" || strings.HasPrefix(next, " ") || strings.HasPrefix(next, "\t") {
					parts = append(parts, strings.TrimSpace(next))
					i = j
					continue
				}
				break
			}
			out[k] = strings.TrimSpace(strings.Join(parts, " "))
			continue
		}
		if (strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`)) ||
			(strings.HasPrefix(v, `'`) && strings.HasSuffix(v, `'`)) {
			v = v[1 : len(v)-1]
		}
		out[k] = v
	}
	return out
}

// --- handler ---------------------------------------------------------------

func handleClaude(w http.ResponseWriter, r *http.Request, id string) {
	all, err := loadAllAgents()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var a *Agent
	for i := range all {
		if all[i].ID == id {
			a = &all[i]
			break
		}
	}
	if a == nil {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	dir, source, sourceID := effectiveClaudeDir(*a, all)
	skills, agents, commands, plugins, markets, memory := scanClaudeDir(dir, a.ID)
	writeJSON(w, ClaudeDirView{
		Source:       source,
		SourceID:     sourceID,
		Dir:          dir,
		Skills:       skills,
		Agents:       agents,
		Commands:     commands,
		Plugins:      plugins,
		Marketplaces: markets,
		Memory:       memory,
	})
}
