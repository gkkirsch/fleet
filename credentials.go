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

// readPluginCredentials looks for a plugin's declared credentials. First
// choice is .claude-plugin/credentials.json at the plugin's install
// path. Each entry's `Set` is derived from the macOS Keychain under the
// per-agent service name so the UI can show which are already saved.
func readPluginCredentials(installPath, agentID, pluginName, marketplace string) []CredentialDecl {
	if installPath == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(installPath, ".claude-plugin", "credentials.json"))
	if err != nil {
		return nil
	}
	var decls []CredentialDecl
	if err := json.Unmarshal(b, &decls); err != nil {
		return nil
	}
	if agentID == "" {
		return decls
	}
	for i := range decls {
		decls[i].Set = keychainHas(agentID, pluginName, marketplace, decls[i].Key)
	}
	return decls
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
