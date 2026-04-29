// fleetview — minimal local web UI for the roster fleet.
//
// Backend responsibilities:
//  - GET /api/fleet                   → list of agents with merged live status
//  - GET /api/agents/:id/messages     → parsed turns from Claude's JSONL
//  - POST /api/agents/:id/notify      → shell out to `roster notify`
//  - Static: /dist built React app embedded via go:embed (in prod).
//
// Dev mode: run this binary at :8080, then `npm run dev` in web/ at :5173
// with a Vite proxy forwarding /api to :8080.
package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed static/inspector.js
var inspectorJS []byte

// SPA bundle. Built by `cd web && npm run build`. Empty in dev (Vite
// runs separately on :5173 and proxies /api here); populated for
// release builds so the single binary serves everything on :8080.
//
//go:embed all:web/dist
var spaFS embed.FS

var (
	rosterBin = "roster"
	amuxBin   = "amux"
	camuxBin  = "camux"
)

// Agent is the merged record sent to the UI: durable fields from the
// roster JSON on disk + a few derived fields (status, jsonl_path).
type Agent struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Parent      string    `json:"parent,omitempty"`
	Description string    `json:"description,omitempty"`
	SessionUUID string    `json:"session_uuid,omitempty"`
	Target      string    `json:"target,omitempty"`
	Cwd         string    `json:"cwd,omitempty"`
	Created     time.Time `json:"created"`
	LastSeen    time.Time `json:"last_seen,omitempty"`
	Status      string    `json:"status"`
	JSONLPath   string    `json:"jsonl_path,omitempty"`
}

// rosterAgent mirrors the on-disk schema from roster's store.
type rosterAgent struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Parent      string    `json:"parent"`
	Description string    `json:"description"`
	SessionUUID string    `json:"session_uuid"`
	SpawnArgs   []string  `json:"spawn_args"`
	Cwd         string    `json:"cwd"`
	Target      string    `json:"target"`
	Created     time.Time `json:"created"`
	LastSeen    time.Time `json:"last_seen"`
}

// --- roster dir resolution -------------------------------------------------

func rosterAgentsDir() string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		return d
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "agents")
}

// loadAllAgents reads every JSON in the roster agents dir.
func loadAllAgents() ([]Agent, error) {
	dir := rosterAgentsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Agent{}, nil
		}
		return nil, err
	}
	var agents []Agent
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var r rosterAgent
		if err := json.Unmarshal(b, &r); err != nil {
			continue
		}
		agents = append(agents, Agent{
			ID:          r.ID,
			Kind:        r.Kind,
			Parent:      r.Parent,
			Description: r.Description,
			SessionUUID: r.SessionUUID,
			Target:      r.Target,
			Cwd:         r.Cwd,
			Created:     r.Created,
			LastSeen:    r.LastSeen,
			Status:      camuxStatus(r.Target),
			JSONLPath:   findJSONLPath(r.SessionUUID, r.Cwd),
		})
	}
	sort.Slice(agents, func(i, j int) bool {
		return agents[i].Created.Before(agents[j].Created)
	})
	return agents, nil
}

// camuxStatus is a best-effort live probe. If camux isn't available or
// the target's gone, returns "stopped"/"unknown".
func camuxStatus(target string) string {
	if target == "" {
		return "stopped"
	}
	cmd := exec.Command(camuxBin, "status", target)
	var out bytes.Buffer
	cmd.Stdout = &out
	_ = cmd.Run()
	s := strings.TrimSpace(out.String())
	if s == "" {
		return "unknown"
	}
	return s
}

// findJSONLPath returns the path of the JSONL file for a Claude session.
//
// Always trust the registered uuid when its jsonl exists — multiple
// agents (an orchestrator and its workers) commonly share a single
// CLAUDE_CONFIG_DIR, so "newest in dir" can't disambiguate which
// agent owns which session.
//
// Only when the registered file is gone (Claude Code rolled the
// session via /clear and roster's stored uuid hasn't caught up yet)
// do we fall back to the newest jsonl in the same project dir.
//
// Search order:
//   1. Per-orch isolated dirs: <roster_data>/claude/*/projects/*/<uuid>.jsonl
//   2. The user's global ~/.claude/projects/*/<uuid>.jsonl
func findJSONLPath(uuid, cwd string) string {
	if uuid == "" {
		return ""
	}
	for _, base := range claudeProjectRoots() {
		pattern := filepath.Join(base, "*", uuid+".jsonl")
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			return matches[0]
		}
	}
	// Registered file not found anywhere — try the newest jsonl in
	// the project dir for the agent's cwd as a last-resort fallback.
	if cwd != "" {
		project := strings.ReplaceAll(cwd, "/", "-")
		for _, base := range claudeProjectRoots() {
			if newer := newestJSONL(filepath.Join(base, project)); newer != "" {
				return newer
			}
		}
	}
	return ""
}

// newestJSONL returns the most recently modified .jsonl in dir, or "".
func newestJSONL(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var newestPath string
	var newestMod time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newestPath = filepath.Join(dir, e.Name())
		}
	}
	return newestPath
}

// claudeProjectRoots returns every <something>/projects directory we
// might find a session JSONL under.
func claudeProjectRoots() []string {
	var roots []string
	// Per-orch isolated dirs first (more specific).
	if rosterClaude := rosterClaudeRoot(); rosterClaude != "" {
		entries, _ := os.ReadDir(rosterClaude)
		for _, e := range entries {
			if e.IsDir() {
				roots = append(roots, filepath.Join(rosterClaude, e.Name(), "projects"))
			}
		}
	}
	// User global last.
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".claude", "projects"))
	}
	return roots
}

// rosterClaudeRoot returns <roster_data>/claude (the parent of every
// per-orch isolated dir). Mirrors roster's resolution.
func rosterClaudeRoot() string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		return filepath.Join(filepath.Dir(d), "claude")
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "claude")
}

// --- message parsing -------------------------------------------------------

// Message is one UI-level event derived from one or more JSONL lines.
// We collapse the raw schema into something React can render directly.
type Message struct {
	Time    time.Time `json:"time"`
	Role    string    `json:"role"` // user | assistant | tool_use | tool_result | system
	Text    string    `json:"text,omitempty"`
	Tool    string    `json:"tool,omitempty"`     // for tool_use
	Input   any       `json:"input,omitempty"`    // for tool_use
	Output  string    `json:"output,omitempty"`   // for tool_result
	ToolID  string    `json:"tool_id,omitempty"`  // pairs tool_use ↔ tool_result
	Thinking bool     `json:"thinking,omitempty"` // assistant thinking block
}

// Raw line envelope shared across types in Claude's JSONL.
type jsonlLine struct {
	Type      string          `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
	SessionID string          `json:"sessionId"`
}

func parseMessages(path string) ([]Message, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// Raise the buffer: long tool outputs / file-history-snapshot lines
	// routinely exceed the default 64 KiB.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var out []Message
	for scanner.Scan() {
		var raw jsonlLine
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			continue
		}
		switch raw.Type {
		case "user":
			out = append(out, parseUser(raw)...)
		case "assistant":
			out = append(out, parseAssistant(raw)...)
			// Skip other types: attachment, file-history-snapshot,
			// permission-mode, last-prompt — not directly useful in v0.1
			// UI.
		}
	}
	return out, scanner.Err()
}

// parseUser handles `type:"user"` lines. Observed shapes:
//   1. message is a bare string                                   → text
//   2. message is {role, content: "string"}                       → text
//   3. message is {role, content: [{type,text|tool_result,…}]}    → blocks
func parseUser(raw jsonlLine) []Message {
	// Shape 1: bare string.
	var s string
	if err := json.Unmarshal(raw.Message, &s); err == nil && s != "" {
		return []Message{{Time: raw.Timestamp, Role: "user", Text: s}}
	}
	// Shapes 2 & 3: object. Content can be a string OR an array.
	var obj struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw.Message, &obj); err != nil {
		return nil
	}
	// Shape 2: content is a plain string.
	var contentStr string
	if err := json.Unmarshal(obj.Content, &contentStr); err == nil && contentStr != "" {
		return []Message{{Time: raw.Timestamp, Role: "user", Text: contentStr}}
	}
	// Shape 3: content is an array of blocks.
	var blocks []struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		ToolUseID string `json:"tool_use_id"`
		Content   any    `json:"content"`
	}
	if err := json.Unmarshal(obj.Content, &blocks); err != nil {
		return nil
	}
	var out []Message
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				out = append(out, Message{Time: raw.Timestamp, Role: "user", Text: b.Text})
			}
		case "tool_result":
			out = append(out, Message{
				Time:   raw.Timestamp,
				Role:   "tool_result",
				ToolID: b.ToolUseID,
				Output: anyToString(b.Content),
			})
		}
	}
	return out
}

// parseAssistant handles `type:"assistant"`. Message is usually an array
// of blocks: text, thinking, tool_use.
func parseAssistant(raw jsonlLine) []Message {
	var blocks []struct {
		Type     string          `json:"type"`
		Text     string          `json:"text"`
		Thinking string          `json:"thinking"`
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(raw.Message, &blocks); err != nil {
		// Some assistant lines are wrapped — try the object form.
		var obj struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(raw.Message, &obj) != nil {
			return nil
		}
		if err := json.Unmarshal(obj.Content, &blocks); err != nil {
			return nil
		}
	}
	var out []Message
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				out = append(out, Message{Time: raw.Timestamp, Role: "assistant", Text: b.Text})
			}
		case "thinking":
			if strings.TrimSpace(b.Thinking) != "" {
				out = append(out, Message{Time: raw.Timestamp, Role: "assistant", Thinking: true, Text: b.Thinking})
			}
		case "tool_use":
			var input any
			_ = json.Unmarshal(b.Input, &input)
			out = append(out, Message{
				Time:   raw.Timestamp,
				Role:   "tool_use",
				Tool:   b.Name,
				ToolID: b.ID,
				Input:  input,
			})
		}
	}
	return out
}

func anyToString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		// tool_result content is often [{type:"text", text:"…"}]
		var parts []string
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	case nil:
		return ""
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// --- HTTP handlers ---------------------------------------------------------

func handleFleet(w http.ResponseWriter, r *http.Request) {
	agents, err := loadAllAgents()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, agents)
}

func handleMessages(w http.ResponseWriter, r *http.Request, id string) {
	agents, err := loadAllAgents()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var a *Agent
	for i := range agents {
		if agents[i].ID == id {
			a = &agents[i]
			break
		}
	}
	if a == nil {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	if a.JSONLPath == "" {
		writeJSON(w, []Message{})
		return
	}
	msgs, err := parseMessages(a.JSONLPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, msgs)
}

type notifyReq struct {
	Message string `json:"message"`
	From    string `json:"from"`
}

// handleInterrupt sends a single Escape to the target's TUI (camux's
// "interrupt" primitive). Used by the chat UI's stop button when the
// agent is mid-stream. No request body — the agent id alone is the
// target.
func handleInterrupt(w http.ResponseWriter, r *http.Request, id string) {
	a, err := loadAgentMerged(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if a == nil {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	if a.Target == "" {
		http.Error(w, "agent has no target (stopped?)", http.StatusBadRequest)
		return
	}
	cmd := exec.Command(camuxBin, "interrupt", a.Target)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		http.Error(w, strings.TrimSpace(errb.String()), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "interrupted"})
}

// loadAgentMerged is a thin convenience wrapper around loadAllAgents +
// id lookup. Callers that need just one agent shouldn't have to pull
// the full fleet themselves.
func loadAgentMerged(id string) (*Agent, error) {
	all, err := loadAllAgents()
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, nil
}

func handleNotify(w http.ResponseWriter, r *http.Request, id string) {
	var body notifyReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Message) == "" {
		http.Error(w, "empty message", http.StatusBadRequest)
		return
	}
	from := body.From
	if from == "" {
		from = "ui"
	}

	// Self-heal #1: if the recipient is stopped, resume it. Sending a
	// message to a stopped orch was previously a hard error; the user's
	// intent is clearly "talk to this thing" so we boot it for them.
	if a, _ := loadAgentMerged(id); a != nil && a.Status == "stopped" {
		out, err := exec.Command(rosterBin, "resume", id).CombinedOutput()
		if err != nil {
			http.Error(w, fmt.Sprintf("resume %s: %v — %s", id, err, strings.TrimSpace(string(out))), http.StatusInternalServerError)
			return
		}
		// Wait for the agent to actually become ready before piping the
		// message in — otherwise roster's notify will fail its own
		// waitForReady. 30s cap matches roster's internal timeout.
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if a, _ := loadAgentMerged(id); a != nil && a.Status == "ready" {
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
	}

	// Self-heal #2: if the recipient is parked on a permission/trust prompt,
	// roster's notify will time out waiting for "ready". Sending Esc
	// dismisses the prompt and returns Claude Code to the input prompt,
	// which is what the user implicitly wants when they're typing a new
	// message anyway. We only do this for dialog states — never for
	// active streaming, because that would cancel real work.
	if a, _ := loadAgentMerged(id); a != nil && a.Target != "" {
		if a.Status == "permission-dialog" || a.Status == "trust-dialog" {
			_ = exec.Command(camuxBin, "interrupt", a.Target).Run()
			// Brief pause so camux's status pollers see the prompt
			// disappear before roster's waitForReady starts.
			time.Sleep(250 * time.Millisecond)
		}
	}

	cmd := exec.Command(rosterBin, "notify", id, body.Message, "--from", from)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		http.Error(w, strings.TrimSpace(errb.String()), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "delivered"})
}

// handleForget removes an agent (kills tmux session + deletes the
// roster record). For an orchestrator we cascade: every worker whose
// parent is this orch is forgotten first, then the orch itself. The
// dispatcher is intentionally NOT deletable from the UI — it's the
// surface the user is talking to and removing it would brick the app.
func handleForget(w http.ResponseWriter, r *http.Request, id string) {
	all, err := loadAllAgents()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var target *Agent
	for i := range all {
		if all[i].ID == id {
			target = &all[i]
			break
		}
	}
	if target == nil {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	if target.Kind == "dispatcher" {
		http.Error(w, "the dispatcher can't be deleted", http.StatusBadRequest)
		return
	}
	// Forget descendants first so we don't leave orphaned workers
	// pointing at a missing parent. Cascade is single-level today
	// (workers have an orchestrator parent), but we walk the tree
	// recursively in case that changes.
	var deleted []string
	var failed []string
	var visit func(parentID string)
	visit = func(parentID string) {
		for _, a := range all {
			if a.Parent == parentID {
				visit(a.ID)
			}
		}
		if err := runRosterForget(parentID); err != nil {
			failed = append(failed, parentID+": "+err.Error())
		} else {
			deleted = append(deleted, parentID)
		}
	}
	visit(id)
	if len(failed) > 0 {
		http.Error(w, "forget failed for: "+strings.Join(failed, "; "), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"deleted": deleted})
}

func runRosterForget(id string) error {
	cmd := exec.Command(rosterBin, "forget", id)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(errb.String()))
	}
	return nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// --- router ----------------------------------------------------------------

func router() http.Handler {
	mux := http.NewServeMux()

	// Served to artifact iframes via a <script> tag baked into the
	// template. The script is dormant until the parent toggles design
	// mode via postMessage. Same-origin would be cleaner; CORS is on
	// for the dashboard so this works across the Vite/fleetview ports.
	mux.HandleFunc("/__inspector.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(inspectorJS)
	})

	mux.HandleFunc("/api/fleet", handleFleet)
	mux.HandleFunc("/api/agents/", func(w http.ResponseWriter, r *http.Request) {
		// /api/agents/<id>/messages  or  /api/agents/<id>/notify
		rest := strings.TrimPrefix(r.URL.Path, "/api/agents/")
		parts := strings.SplitN(rest, "/", 2)
		if len(parts) != 2 {
			http.Error(w, "usage: /api/agents/<id>/{messages,notify}", http.StatusBadRequest)
			return
		}
		id, sub := parts[0], parts[1]
		switch sub {
		case "messages":
			if r.Method != http.MethodGet {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleMessages(w, r, id)
		case "notify":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleNotify(w, r, id)
		case "claude":
			if r.Method != http.MethodGet {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleClaude(w, r, id)
		case "plugins/install":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleInstallPlugin(w, r, id)
		case "plugins/apply-schedule":
			handleApplyPluginSchedule(w, r, id)
		case "plugins/run-script":
			handleRunPluginScript(w, r, id)
		case "marketplaces":
			handleMarketplaces(w, r, id)
		case "credentials":
			handleCredentials(w, r, id)
		case "browser":
			handleBrowser(w, r, id)
		case "interrupt":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleInterrupt(w, r, id)
		case "upload":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleUpload(w, r, id)
		case "forget":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			handleForget(w, r, id)
		default:
			if strings.HasPrefix(sub, "artifacts") {
				handleArtifacts(w, r, id, strings.TrimPrefix(sub, "artifacts"))
				return
			}
			if strings.HasPrefix(sub, "schedules") {
				handleSchedules(w, r, id, strings.TrimPrefix(sub, "schedules"))
				return
			}
			http.Error(w, "unknown subresource", http.StatusNotFound)
		}
	})

	// Static SPA. In a release build web/dist is populated and we serve
	// it; in dev (where dist is empty) we keep the legacy "run Vite"
	// hint so a curl from the wrong port still tells you what to do.
	mux.HandleFunc("/", spaHandler())

	return withCORS(mux)
}

// spaHandler serves the embedded Vite bundle. SPA routing: any path
// that doesn't match a real file falls back to index.html (so the
// React client owns its own routes). In dev (dist is empty) it
// degrades to the "run Vite" hint so the wrong port surfaces an
// actionable message instead of a 404.
func spaHandler() http.HandlerFunc {
	dist, err := fs.Sub(spaFS, "web/dist")
	if err != nil {
		return func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "spa fs sub: "+err.Error(), http.StatusInternalServerError)
		}
	}
	indexBytes, indexErr := fs.ReadFile(dist, "index.html")
	dev := indexErr != nil // no dist embedded → dev build
	files := http.FileServerFS(dist)

	return func(w http.ResponseWriter, r *http.Request) {
		if dev {
			if r.URL.Path == "/" {
				fmt.Fprintln(w, "fleetview backend — run Vite dev server at :5173")
				return
			}
			http.NotFound(w, r)
			return
		}
		// Try to serve the file directly. If it's missing AND looks
		// like a client-side route (no extension, GET), fall back to
		// index.html so the SPA can take over.
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(indexBytes)
			return
		}
		if _, err := fs.Stat(dist, clean); err == nil {
			files.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet && !strings.Contains(filepath.Base(r.URL.Path), ".") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(indexBytes)
			return
		}
		http.NotFound(w, r)
	}
}

// withCORS lets the Vite dev server on :5173 hit :8080 freely.
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// --- main ------------------------------------------------------------------

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address (localhost-only by default)")
	flag.Parse()

	if v := os.Getenv("ROSTER_BIN"); v != "" {
		rosterBin = v
	}
	if v := os.Getenv("AMUX_BIN"); v != "" {
		amuxBin = v
	}
	if v := os.Getenv("CAMUX_BIN"); v != "" {
		camuxBin = v
	}
	_ = io.Discard // silence unused import if we pull it back for embed later

	fmt.Fprintf(os.Stderr, "fleetview on http://%s — Vite dev: cd web && npm run dev\n", *addr)
	if err := http.ListenAndServe(*addr, router()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
