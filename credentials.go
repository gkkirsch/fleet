package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// readPluginConfig reads a plugin's setup metadata. Two sources, in
// preference order:
//
//  1. .claude-plugin/config.json — Flow's richer schema (credentials +
//     schedules + setup_scripts)
//  2. .claude-plugin/credentials.json — legacy, credentials only
//
// Returns the credentials, suggested schedules, and setup scripts.
// Each schedule's `Applied` is set if the orch already has a task with
// the same id in its scheduled_tasks.json.
func readPluginConfig(installPath, claudeDir, agentID, pluginName, marketplace string) (
	creds []CredentialDecl,
	schedules []ScheduleSuggestion,
	scripts []SetupScript,
) {
	if installPath == "" {
		return nil, nil, nil
	}
	cfgPath := filepath.Join(installPath, ".claude-plugin", "config.json")
	if b, err := os.ReadFile(cfgPath); err == nil {
		var cfg struct {
			Credentials  []CredentialDecl     `json:"credentials"`
			Schedules    []ScheduleSuggestion `json:"schedules"`
			SetupScripts []SetupScript        `json:"setup_scripts"`
		}
		if err := json.Unmarshal(b, &cfg); err == nil {
			creds = cfg.Credentials
			schedules = cfg.Schedules
			scripts = cfg.SetupScripts
		}
	} else {
		// Fallback: credentials.json only.
		legacyPath := filepath.Join(installPath, ".claude-plugin", "credentials.json")
		if b, err := os.ReadFile(legacyPath); err == nil {
			_ = json.Unmarshal(b, &creds)
		}
	}

	if agentID != "" {
		for i := range creds {
			creds[i].Set = keychainHas(agentID, pluginName, marketplace, creds[i].Key)
		}
	}

	if len(schedules) > 0 && claudeDir != "" {
		appliedIDs := readAppliedScheduleIDs(claudeDir)
		for i := range schedules {
			schedules[i].Applied = appliedIDs[schedules[i].ID]
		}
	}

	return creds, schedules, scripts
}

// readAppliedScheduleIDs returns the set of task ids currently in the
// orch's scheduled_tasks.json. Returns empty map if file missing.
func readAppliedScheduleIDs(claudeDir string) map[string]bool {
	path := filepath.Join(claudeDir, "scheduled_tasks.json")
	out := map[string]bool{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var doc struct {
		Tasks []struct {
			ID string `json:"id"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return out
	}
	for _, t := range doc.Tasks {
		if t.ID != "" {
			out[t.ID] = true
		}
	}
	return out
}

// keychainService keys our stored secrets by agent. Account bundles the
// plugin identity + credential key so two plugins can share a key name
// without clashing.
func keychainService(agentID string) string {
	return "fleetview-" + agentID
}

func keychainAccount(pluginName, marketplace, key string) string {
	return fmt.Sprintf("%s@%s/%s", pluginName, marketplace, key)
}

// keychainHas is a fast check: exit 0 from `security find-generic-password`
// means the item exists (we don't need the value).
func keychainHas(agentID, pluginName, marketplace, key string) bool {
	cmd := exec.Command("security", "find-generic-password",
		"-s", keychainService(agentID),
		"-a", keychainAccount(pluginName, marketplace, key))
	return cmd.Run() == nil
}

func keychainSet(agentID, pluginName, marketplace, key, value string) error {
	// -U updates-if-exists so we don't have to delete-then-add.
	cmd := exec.Command("security", "add-generic-password",
		"-s", keychainService(agentID),
		"-a", keychainAccount(pluginName, marketplace, key),
		"-w", value,
		"-U")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func keychainDelete(agentID, pluginName, marketplace, key string) error {
	cmd := exec.Command("security", "delete-generic-password",
		"-s", keychainService(agentID),
		"-a", keychainAccount(pluginName, marketplace, key))
	_ = cmd.Run() // swallow "not found"
	return nil
}

// --- HTTP handler ----------------------------------------------------------

type credentialReq struct {
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	Key         string `json:"key"`
	Value       string `json:"value,omitempty"` // omit or empty on DELETE
}

func handleCredentials(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body credentialReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Plugin == "" || body.Marketplace == "" || body.Key == "" {
		http.Error(w, "plugin, marketplace, key required", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodDelete {
		_ = keychainDelete(id, body.Plugin, body.Marketplace, body.Key)
		writeJSON(w, map[string]any{"status": "cleared"})
		return
	}
	if body.Value == "" {
		http.Error(w, "value required", http.StatusBadRequest)
		return
	}
	if err := keychainSet(id, body.Plugin, body.Marketplace, body.Key, body.Value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"status": "saved"})
}
