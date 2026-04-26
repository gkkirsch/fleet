package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// installReq is POST /api/agents/:id/plugins/install payload.
type installReq struct {
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	// Source URL/GitHub slug. Only used if marketplace isn't registered.
	Source string `json:"source,omitempty"`
	// Restart claude (kill + roster resume) after install so the running
	// agent picks up the new plugin. Without this the plugin is installed
	// to disk but won't load until the next spawn.
	Restart bool `json:"restart,omitempty"`
}

// handleInstallPlugin runs `claude plugin install` directly against the
// agent's isolated CLAUDE_CONFIG_DIR. No TUI interaction — Claude Code's
// CLI writes installed_plugins.json itself. Optionally restarts the agent.
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
	dir, _, _ := effectiveClaudeDir(*a, all)
	if dir == "" {
		http.Error(w, "no CLAUDE_CONFIG_DIR for agent", http.StatusBadRequest)
		return
	}

	env := append(os.Environ(), "CLAUDE_CONFIG_DIR="+dir)

	var outputs []string
	runClaude := func(args ...string) error {
		cmd := exec.Command("claude", args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		outputs = append(outputs, fmt.Sprintf("$ claude %s\n%s", strings.Join(args, " "), strings.TrimSpace(string(out))))
		if err != nil {
			return fmt.Errorf("%v — %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}

	// If the marketplace isn't registered in this dir yet, add it first.
	if body.Source != "" && !marketplaceRegistered(dir, body.Marketplace) {
		if err := runClaude("plugin", "marketplace", "add", body.Source); err != nil {
			http.Error(w, fmt.Sprintf("marketplace add: %v", err), http.StatusInternalServerError)
			return
		}
	}

	spec := fmt.Sprintf("%s@%s", body.Plugin, body.Marketplace)
	if err := runClaude("plugin", "install", spec); err != nil {
		http.Error(w, fmt.Sprintf("install: %v", err), http.StatusInternalServerError)
		return
	}

	if body.Restart && a.Target != "" {
		go restartAgent(id, a.Target)
	}

	writeJSON(w, map[string]any{
		"status":  "installed",
		"plugin":  spec,
		"output":  outputs,
		"restart": body.Restart,
	})
}

// marketplaceRegistered checks if plugins/marketplaces/<name>(.json?) exists
// — i.e. the dir has already seen this marketplace.
func marketplaceRegistered(dir, name string) bool {
	for _, cand := range []string{
		filepath.Join(dir, "plugins", "marketplaces", name),
		filepath.Join(dir, "plugins", "marketplaces", name+".json"),
	} {
		if _, err := os.Stat(cand); err == nil {
			return true
		}
	}
	return false
}

// restartAgent kills the amux window and re-spawns via roster resume so
// claude reads the fresh installed_plugins.json on boot.
func restartAgent(id, target string) {
	time.Sleep(1 * time.Second)
	_ = exec.Command(amuxBin, "kill", target).Run()
	time.Sleep(500 * time.Millisecond)
	_ = exec.Command(rosterBin, "resume", id).Run()
}
