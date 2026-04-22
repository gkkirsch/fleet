package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// installReq is POST /api/agents/:id/plugins/install payload.
type installReq struct {
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	// Source URL or GitHub slug. Only used if the marketplace isn't
	// already registered. Skip for marketplaces the agent already has.
	Source string `json:"source,omitempty"`
	// When true, restart claude (kill + roster resume) after the install
	// lands so the new plugin is picked up on boot.
	Restart bool `json:"restart,omitempty"`
}

func handleInstallPlugin(w http.ResponseWriter, r *http.Request, id string) {
	var body installReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Plugin) == "" || strings.TrimSpace(body.Marketplace) == "" {
		http.Error(w, "plugin and marketplace required", http.StatusBadRequest)
		return
	}

	// Find the agent so we know its target.
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
	if a == nil || a.Target == "" {
		http.Error(w, "no live target for agent", http.StatusNotFound)
		return
	}

	// Compose the commands to paste. Each goes in on its own via amux paste
	// --submit so claude's TUI slash-command handler sees it cleanly.
	var cmds []string
	if body.Source != "" {
		cmds = append(cmds, fmt.Sprintf("/plugin marketplace add %s", body.Source))
	}
	cmds = append(cmds, fmt.Sprintf("/plugin install %s@%s", body.Plugin, body.Marketplace))

	for i, c := range cmds {
		if err := amuxPasteSubmit(a.Target, c); err != nil {
			http.Error(w, fmt.Sprintf("paste %d: %v", i, err), http.StatusInternalServerError)
			return
		}
		// Give claude a moment to process before pushing the next line.
		time.Sleep(800 * time.Millisecond)
	}

	if body.Restart {
		go restartAgent(id, a.Target)
	}

	writeJSON(w, map[string]any{
		"status":  "sent",
		"commands": cmds,
		"restart":  body.Restart,
	})
}

// amuxPasteSubmit pipes text into `amux paste <target> --submit`.
func amuxPasteSubmit(target, text string) error {
	cmd := exec.Command(amuxBin, "paste", target, "--submit")
	cmd.Stdin = strings.NewReader(text)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %s", err, strings.TrimSpace(errb.String()))
	}
	return nil
}

// restartAgent kills the target window and resumes the roster agent so
// claude re-reads installed_plugins.json. Runs async; errors log to stderr
// only — the UI can repoll and see the new state.
func restartAgent(id, target string) {
	// Small delay to let the install finish writing files.
	time.Sleep(5 * time.Second)
	_ = exec.Command(amuxBin, "kill", target).Run()
	time.Sleep(500 * time.Millisecond)
	_ = exec.Command(rosterBin, "resume", id).Run()
}
