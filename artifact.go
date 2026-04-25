package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Per-orch artifact dev-server lifecycle. Each artifact is a small Vite
// app scaffolded by `roster artifact create`; this layer exposes:
//
//   GET  /api/agents/:id/artifacts                    list
//   POST /api/agents/:id/artifacts/:aid/serve         lazy-spawn npm install + vite dev
//   POST /api/agents/:id/artifacts/:aid/stop          kill the running dev server
//
// The dev server's PID is persisted next to the artifact at
// <dir>/.vite.pid so a restart of fleetview can adopt or reap leftover
// Vite processes without scanning all of `ps`.
//
// HMR is Vite's job — fleetview just exposes the port so the UI can
// point an iframe at it.

// ArtifactSidecar mirrors roster's on-disk schema. Kept as a separate
// type here so fleetview doesn't depend on roster as a Go module.
type ArtifactSidecar struct {
	ID      string    `json:"id"`
	Type    string    `json:"type"`
	Title   string    `json:"title,omitempty"`
	Port    int       `json:"port"`
	Created time.Time `json:"created"`
}

// ArtifactView is the API shape — sidecar plus a runtime status.
type ArtifactView struct {
	ArtifactSidecar
	Path   string `json:"path"`
	Status string `json:"status"` // idle | installing | starting | ready | crashed
	Alive  bool   `json:"alive"`
	Error  string `json:"error,omitempty"`
}

// --- on-disk locations -----------------------------------------------------

// orchClaudeDirOnDisk mirrors roster's per-orch CLAUDE_CONFIG_DIR
// resolution so we can find <orch_claude_dir>/artifacts/.
func orchClaudeDirOnDisk(orchID string) string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		return filepath.Join(filepath.Dir(d), "claude", orchID)
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "claude", orchID)
}

func artifactsRoot(orchID string) string {
	d := orchClaudeDirOnDisk(orchID)
	if d == "" {
		return ""
	}
	return filepath.Join(d, "artifacts")
}

func artifactDir(orchID, aid string) string {
	r := artifactsRoot(orchID)
	if r == "" {
		return ""
	}
	return filepath.Join(r, aid)
}

func readSidecar(dir string) (*ArtifactSidecar, error) {
	b, err := os.ReadFile(filepath.Join(dir, ".roster-artifact"))
	if err != nil {
		return nil, err
	}
	var s ArtifactSidecar
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// --- process manager -------------------------------------------------------

type managedProc struct {
	cmd     *exec.Cmd
	pid     int
	port    int
	status  string // installing | starting | ready | crashed
	err     error
	started time.Time
}

type artifactManager struct {
	mu    sync.Mutex
	procs map[string]*managedProc // key = orchID + ":" + aid
}

var artifacts = &artifactManager{procs: map[string]*managedProc{}}

func procKey(orchID, aid string) string { return orchID + ":" + aid }

func (m *artifactManager) get(orchID, aid string) *managedProc {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.procs[procKey(orchID, aid)]
}

func (m *artifactManager) set(orchID, aid string, p *managedProc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.procs[procKey(orchID, aid)] = p
}

func (m *artifactManager) clear(orchID, aid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.procs, procKey(orchID, aid))
}

// portAlive does a fast TCP probe — Vite responds with HTTP but we
// only care that the port is bound.
func portAlive(port int) bool {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	c, err := net.DialTimeout("tcp", addr, 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// pidAlive returns true if the OS still has the PID. Cheap; just sends
// signal 0.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// adoptOrSpawnVite is the workhorse. Returns the (possibly-updated)
// proc state. Always non-blocking — npm install / vite startup runs
// in a goroutine; callers poll status.
func (m *artifactManager) ensureServing(orchID, aid string) (*ArtifactView, error) {
	dir := artifactDir(orchID, aid)
	if dir == "" {
		return nil, fmt.Errorf("could not resolve artifact dir")
	}
	side, err := readSidecar(dir)
	if err != nil {
		return nil, fmt.Errorf("read sidecar: %w", err)
	}

	view := &ArtifactView{ArtifactSidecar: *side, Path: dir}

	// Fast path: port responding → ready.
	if portAlive(side.Port) {
		view.Alive = true
		view.Status = "ready"
		return view, nil
	}

	// Check tracked proc.
	m.mu.Lock()
	cur := m.procs[procKey(orchID, aid)]
	m.mu.Unlock()
	if cur != nil && pidAlive(cur.pid) {
		view.Status = cur.status
		if cur.err != nil {
			view.Error = cur.err.Error()
		}
		return view, nil
	}

	// Otherwise spawn fresh. node_modules check decides whether we
	// need to npm install first.
	needsInstall := false
	if _, err := os.Stat(filepath.Join(dir, "node_modules")); os.IsNotExist(err) {
		needsInstall = true
	}
	p := &managedProc{
		port:    side.Port,
		started: time.Now(),
	}
	if needsInstall {
		p.status = "installing"
	} else {
		p.status = "starting"
	}
	m.set(orchID, aid, p)
	go m.driveLifecycle(orchID, aid, dir, side.Port, needsInstall)

	view.Status = p.status
	return view, nil
}

// driveLifecycle runs npm install (if needed) and vite dev in
// sequence, keeping the managedProc state updated as it goes.
func (m *artifactManager) driveLifecycle(orchID, aid, dir string, port int, doInstall bool) {
	if doInstall {
		install := exec.Command("npm", "install", "--no-audit", "--no-fund", "--prefer-offline")
		install.Dir = dir
		logFile, _ := os.Create(filepath.Join(dir, ".vite.npm-install.log"))
		if logFile != nil {
			install.Stdout = logFile
			install.Stderr = logFile
		}
		if err := install.Run(); err != nil {
			if logFile != nil {
				_ = logFile.Close()
			}
			cur := m.get(orchID, aid)
			if cur != nil {
				cur.status = "crashed"
				cur.err = fmt.Errorf("npm install failed: %w (see %s)", err, install.Path)
			}
			return
		}
		if logFile != nil {
			_ = logFile.Close()
		}
	}

	cur := m.get(orchID, aid)
	if cur != nil {
		cur.status = "starting"
	}

	cmd := exec.Command("npm", "run", "dev", "--", "--port", strconv.Itoa(port))
	cmd.Dir = dir
	logFile, _ := os.Create(filepath.Join(dir, ".vite.log"))
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		cur := m.get(orchID, aid)
		if cur != nil {
			cur.status = "crashed"
			cur.err = err
		}
		return
	}
	pid := cmd.Process.Pid
	_ = os.WriteFile(filepath.Join(dir, ".vite.pid"), []byte(strconv.Itoa(pid)), 0o644)
	if cur := m.get(orchID, aid); cur != nil {
		cur.cmd = cmd
		cur.pid = pid
	}
	go func() {
		// Detach: don't tie Vite's lifetime to fleetview, but do
		// wait so we can update status if it dies.
		_ = cmd.Wait()
		if logFile != nil {
			_ = logFile.Close()
		}
		if cur := m.get(orchID, aid); cur != nil && cur.pid == pid {
			if portAlive(port) {
				return
			}
			cur.status = "crashed"
		}
	}()
	// Poll until port binds or we give up.
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if portAlive(port) {
			if cur := m.get(orchID, aid); cur != nil {
				cur.status = "ready"
			}
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	if cur := m.get(orchID, aid); cur != nil && cur.status != "ready" {
		cur.status = "crashed"
		cur.err = fmt.Errorf("vite did not bind :%d within 45s", port)
	}
}

// stopServing kills the tracked proc (and the persisted PID, in case
// fleetview restarted between spawn and stop). Best-effort; errors
// surface to the caller but don't mutate sidecar.
func (m *artifactManager) stopServing(orchID, aid string) error {
	dir := artifactDir(orchID, aid)
	if dir == "" {
		return fmt.Errorf("no such artifact")
	}
	if cur := m.get(orchID, aid); cur != nil && cur.cmd != nil && cur.cmd.Process != nil {
		_ = cur.cmd.Process.Signal(syscall.SIGTERM)
		// Don't wait — Wait() goroutine handles cleanup.
	}
	if b, err := os.ReadFile(filepath.Join(dir, ".vite.pid")); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Signal(syscall.SIGTERM)
			}
		}
		_ = os.Remove(filepath.Join(dir, ".vite.pid"))
	}
	m.clear(orchID, aid)
	return nil
}

// --- HTTP -----------------------------------------------------------------

// handleArtifacts dispatches sub-paths under /api/agents/:id/artifacts.
// `tail` is the portion AFTER "artifacts" (so empty = list, "/aid/serve"
// = serve, etc.).
func handleArtifacts(w http.ResponseWriter, r *http.Request, orchID, tail string) {
	tail = strings.TrimPrefix(tail, "/")

	if tail == "" {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		handleArtifactList(w, orchID)
		return
	}

	parts := strings.SplitN(tail, "/", 2)
	aid := parts[0]
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}

	switch action {
	case "":
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		handleArtifactGet(w, orchID, aid)
	case "serve":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		handleArtifactServe(w, orchID, aid)
	case "stop":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		handleArtifactStop(w, orchID, aid)
	default:
		http.Error(w, "unknown artifact action", http.StatusNotFound)
	}
}

func handleArtifactList(w http.ResponseWriter, orchID string) {
	root := artifactsRoot(orchID)
	if root == "" {
		http.Error(w, "could not resolve artifacts dir", http.StatusInternalServerError)
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var out []ArtifactView
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		side, err := readSidecar(dir)
		if err != nil {
			continue
		}
		view := ArtifactView{ArtifactSidecar: *side, Path: dir}
		view.Alive = portAlive(side.Port)
		if view.Alive {
			view.Status = "ready"
		} else if cur := artifacts.get(orchID, side.ID); cur != nil {
			view.Status = cur.status
			if cur.err != nil {
				view.Error = cur.err.Error()
			}
		} else {
			view.Status = "idle"
		}
		out = append(out, view)
	}
	if out == nil {
		out = []ArtifactView{}
	}
	writeJSON(w, out)
}

func handleArtifactGet(w http.ResponseWriter, orchID, aid string) {
	dir := artifactDir(orchID, aid)
	if dir == "" {
		http.Error(w, "no artifact dir", http.StatusInternalServerError)
		return
	}
	side, err := readSidecar(dir)
	if err != nil {
		http.Error(w, "no such artifact", http.StatusNotFound)
		return
	}
	view := ArtifactView{ArtifactSidecar: *side, Path: dir}
	view.Alive = portAlive(side.Port)
	if view.Alive {
		view.Status = "ready"
	} else if cur := artifacts.get(orchID, aid); cur != nil {
		view.Status = cur.status
		if cur.err != nil {
			view.Error = cur.err.Error()
		}
	} else {
		view.Status = "idle"
	}
	writeJSON(w, view)
}

func handleArtifactServe(w http.ResponseWriter, orchID, aid string) {
	view, err := artifacts.ensureServing(orchID, aid)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

func handleArtifactStop(w http.ResponseWriter, orchID, aid string) {
	if err := artifacts.stopServing(orchID, aid); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "stopped"})
}
