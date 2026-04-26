package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// Per-space browser launcher. Each orchestrator gets its own Chrome
// profile + deterministic CDP port — both derived in roster, mirrored
// here so the UI can launch real Chrome without an extra round-trip.
//
// We launch the user's actual Chrome.app (not Playwright's bundled
// Chromium) with --remote-debugging-port. agent-browser inside the
// space connects via CDP to this Chrome — same fingerprint as a
// regular browsing session.

const (
	cdpPortBase  = 9300
	cdpPortRange = 100
)

// cdpPortFor mirrors roster's hash. Keep these in sync.
func cdpPortFor(orchID string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(orchID))
	return cdpPortBase + int(h.Sum32()%uint32(cdpPortRange))
}

// browserProfileDir mirrors roster's resolution. Returns "" if we can't
// resolve the data home; caller should treat that as a config error.
func browserProfileDir(orchID string) string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		return filepath.Join(filepath.Dir(d), "browser-profiles", orchID)
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "browser-profiles", orchID)
}

// chromeAlive probes the CDP /json/version endpoint with a short timeout.
// Anything other than a 2xx counts as not-alive.
func chromeAlive(port int) bool {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	client := http.Client{Timeout: 800 * time.Millisecond}
	resp, err := client.Get("http://" + addr + "/json/version")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// launchChrome spawns headed Chrome with the per-space profile and CDP
// port. No-op (returns nil) if Chrome on that port is already alive.
//
// Flag-set rationale: we deliberately keep this minimal so Chrome
// behaves like a normal user session. Skipping --enable-automation
// means Chrome doesn't set navigator.webdriver, doesn't show the
// "controlled by automated test software" infobar, and doesn't
// trigger the "unsupported command-line flag" warning banner that
// --disable-blink-features=AutomationControlled provokes.
//
// Caveat: --remote-debugging-port itself is a Cloudflare bot-fight
// signal. No flag mitigates it; an extension-bridge would. Accepting
// for v1.
func launchChrome(orchID string) (port int, profile string, err error) {
	port = cdpPortFor(orchID)
	profile = browserProfileDir(orchID)
	if profile == "" {
		return port, "", fmt.Errorf("could not resolve browser profile dir")
	}
	if chromeAlive(port) {
		return port, profile, nil
	}
	if err := os.MkdirAll(profile, 0o755); err != nil {
		return port, profile, err
	}
	if err := writeProfileIdentity(profile, orchID); err != nil {
		// Non-fatal — Chrome will still launch, just without the
		// per-space name/color tint.
		fmt.Fprintf(os.Stderr, "browser: writeProfileIdentity %s: %v\n", orchID, err)
	}
	chrome := chromeBinary()
	if chrome == "" {
		return port, profile, fmt.Errorf("Google Chrome not found on this system")
	}
	args := []string{
		"--user-data-dir=" + profile,
		"--remote-debugging-port=" + strconv.Itoa(port),
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,800",
		"about:blank",
	}
	cmd := exec.Command(chrome, args...)
	// Detach: don't tie Chrome's lifetime to fleetview's.
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return port, profile, err
	}
	// Don't Wait — let Chrome run independently. Reaping is the OS's
	// problem; on darwin Chrome forks itself anyway.
	go func() { _ = cmd.Wait() }()
	// Give Chrome a moment to bind the CDP port before we return so the
	// UI doesn't race a "not alive" probe immediately after.
	for i := 0; i < 40; i++ {
		if chromeAlive(port) {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	return port, profile, nil
}

// writeProfileIdentity sets the profile name (= orch ID) and a
// deterministic theme color in <profile>/Default/Preferences. Chrome
// reads this on launch when there's no Secure Preferences yet, so a
// fresh profile picks up our name+tint and you can tell the windows
// apart at a glance. Existing prefs are merged, not clobbered.
func writeProfileIdentity(profileDir, orchID string) error {
	defaultDir := filepath.Join(profileDir, "Default")
	if err := os.MkdirAll(defaultDir, 0o755); err != nil {
		return err
	}
	prefsPath := filepath.Join(defaultDir, "Preferences")
	prefs := map[string]any{}
	if b, err := os.ReadFile(prefsPath); err == nil {
		_ = json.Unmarshal(b, &prefs)
	}
	profile, _ := prefs["profile"].(map[string]any)
	if profile == nil {
		profile = map[string]any{}
	}
	profile["name"] = orchID
	profile["using_default_name"] = false
	profile["using_default_avatar"] = false
	profile["using_gaia_avatar"] = false
	prefs["profile"] = profile

	browser, _ := prefs["browser"].(map[string]any)
	if browser == nil {
		browser = map[string]any{}
	}
	theme, _ := browser["theme"].(map[string]any)
	if theme == nil {
		theme = map[string]any{}
	}
	theme["user_color"] = colorForOrch(orchID)
	browser["theme"] = theme
	prefs["browser"] = browser

	out, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(prefsPath, out, 0o644)
}

// colorForOrch returns Chrome's packed RGB int (R<<16 | G<<8 | B) from a
// deterministic hue derived from the orch ID. Saturation and lightness
// are fixed so all spaces sit in the same vibe.
func colorForOrch(orchID string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(orchID))
	hue := float64(h.Sum32()%360) / 360.0
	r, g, b := hslToRGB(hue, 0.55, 0.55)
	return (r << 16) | (g << 8) | b
}

func hslToRGB(h, s, l float64) (int, int, int) {
	if s == 0 {
		v := int(math.Round(l * 255))
		return v, v, v
	}
	var q float64
	if l < 0.5 {
		q = l * (1 + s)
	} else {
		q = l + s - l*s
	}
	p := 2*l - q
	r := hueToRGB(p, q, h+1.0/3)
	g := hueToRGB(p, q, h)
	b := hueToRGB(p, q, h-1.0/3)
	return int(math.Round(r * 255)), int(math.Round(g * 255)), int(math.Round(b * 255))
}

func hueToRGB(p, q, t float64) float64 {
	if t < 0 {
		t += 1
	}
	if t > 1 {
		t -= 1
	}
	if t < 1.0/6 {
		return p + (q-p)*6*t
	}
	if t < 1.0/2 {
		return q
	}
	if t < 2.0/3 {
		return p + (q-p)*(2.0/3-t)*6
	}
	return p
}

func chromeBinary() string {
	if v := os.Getenv("CHROME_BIN"); v != "" {
		return v
	}
	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// browserOrchFor: orchestrators map to themselves; workers walk up to
// their orch ancestor; dispatchers/orphan workers return "".
func browserOrchFor(a Agent, all []Agent) string {
	switch a.Kind {
	case "orchestrator":
		return a.ID
	case "worker":
		return findOrchAncestor(a.Parent, all)
	}
	return ""
}

// --- HTTP handler ----------------------------------------------------------

type browserStatus struct {
	OrchID  string `json:"orch_id,omitempty"`
	Port    int    `json:"port,omitempty"`
	Profile string `json:"profile,omitempty"`
	Alive   bool   `json:"alive"`
	Error   string `json:"error,omitempty"`
}

// handleBrowser:
//
//	GET    → status (port, profile, alive)
//	POST   → ensure Chrome is running for this space, then status.
//
// Both return 404 if the agent doesn't have an orchestrator context
// (dispatcher with no orch ancestor — there's no per-space browser).
func handleBrowser(w http.ResponseWriter, r *http.Request, id string) {
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
	orch := browserOrchFor(*a, all)
	if orch == "" {
		http.Error(w, "agent has no orchestrator browser context", http.StatusNotFound)
		return
	}

	if r.Method == http.MethodGet {
		port := cdpPortFor(orch)
		writeJSON(w, browserStatus{
			OrchID:  orch,
			Port:    port,
			Profile: browserProfileDir(orch),
			Alive:   chromeAlive(port),
		})
		return
	}
	if r.Method == http.MethodPost {
		port, profile, err := launchChrome(orch)
		s := browserStatus{
			OrchID:  orch,
			Port:    port,
			Profile: profile,
			Alive:   chromeAlive(port),
		}
		if err != nil {
			s.Error = err.Error()
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(s)
			return
		}
		writeJSON(w, s)
		return
	}
	http.Error(w, "method", http.StatusMethodNotAllowed)
}
