package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
)

// Per-space browser launcher. We delegate to the roster CLI — roster
// owns the per-orch profile, port, identity, and Chrome launch. This
// file is just the HTTP edge: parse the request, resolve the orch,
// shell out, return the JSON. Keeping all the launch policy in one
// place (roster) means agents and the UI can't drift apart.

// browserStatus mirrors what `roster browser status|launch` prints.
// We pass it through verbatim to the UI.
type browserStatus struct {
	OrchID  string `json:"orch_id,omitempty"`
	Port    int    `json:"port,omitempty"`
	Profile string `json:"profile,omitempty"`
	Alive   bool   `json:"alive"`
	Error   string `json:"error,omitempty"`
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

// rosterBrowser shells to `roster browser <sub> <orch>` and parses the
// JSON. sub is "status" or "launch".
func rosterBrowser(sub, orch string) (browserStatus, error) {
	out, err := exec.Command("roster", "browser", sub, orch).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return browserStatus{}, fmt.Errorf("roster browser %s: %s", sub, string(ee.Stderr))
		}
		return browserStatus{}, fmt.Errorf("roster browser %s: %w", sub, err)
	}
	var s browserStatus
	if err := json.Unmarshal(out, &s); err != nil {
		return browserStatus{}, fmt.Errorf("roster browser %s: parse: %w", sub, err)
	}
	return s, nil
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

	sub := "status"
	if r.Method == http.MethodPost {
		sub = "launch"
	} else if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	s, err := rosterBrowser(sub, orch)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(browserStatus{OrchID: orch, Error: err.Error()})
		return
	}
	writeJSON(w, s)
}
