package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// /api/agents/:id/plugins/apply-schedule and /run-script.
//
// Why these aren't free-form: the user already has the regular
// schedules + (eventually) script-running endpoints. These specialized
// versions take a (plugin, marketplace, id) tuple and look the
// definition up in the plugin's config.json — that means the server
// validates the cron/prompt/command came from the plugin author rather
// than trusting whatever the UI sends. No injection surface for a
// rogue page that gets XSS'd into Flow.

type applyScheduleReq struct {
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	ScheduleID  string `json:"schedule_id"`
}

func handleApplyPluginSchedule(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body applyScheduleReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Plugin == "" || body.Marketplace == "" || body.ScheduleID == "" {
		http.Error(w, "plugin, marketplace, schedule_id required", http.StatusBadRequest)
		return
	}

	plugin, claudeDir, err := lookupInstalledPlugin(agentID, body.Plugin, body.Marketplace)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	var match *ScheduleSuggestion
	for i := range plugin.Schedules {
		if plugin.Schedules[i].ID == body.ScheduleID {
			match = &plugin.Schedules[i]
			break
		}
	}
	if match == nil {
		http.Error(w, "schedule not declared by plugin", http.StatusNotFound)
		return
	}

	schedulesPath := filepath.Join(claudeDir, "scheduled_tasks.json")
	sf, err := readScheduleFile(schedulesPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Idempotent: if the suggested id is already there, return success.
	for _, t := range sf.Tasks {
		if t.ID == match.ID {
			writeJSON(w, map[string]any{"status": "already-applied", "id": t.ID})
			return
		}
	}
	sf.Tasks = append(sf.Tasks, Schedule{
		ID:        match.ID,
		Cron:      match.Cron,
		Prompt:    match.Prompt,
		Recurring: match.Recurring,
		Permanent: true,
		CreatedAt: time.Now().UnixMilli(),
	})
	if err := writeScheduleFile(schedulesPath, sf); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"status": "applied", "id": match.ID})
}

type runScriptReq struct {
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	ScriptID    string `json:"script_id"`
}

func handleRunPluginScript(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body runScriptReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Plugin == "" || body.Marketplace == "" || body.ScriptID == "" {
		http.Error(w, "plugin, marketplace, script_id required", http.StatusBadRequest)
		return
	}

	plugin, _, err := lookupInstalledPlugin(agentID, body.Plugin, body.Marketplace)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	var match *SetupScript
	for i := range plugin.SetupScripts {
		if plugin.SetupScripts[i].ID == body.ScriptID {
			match = &plugin.SetupScripts[i]
			break
		}
	}
	if match == nil {
		http.Error(w, "script not declared by plugin", http.StatusNotFound)
		return
	}

	cwd, err := agentCwd(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cmd := exec.Command("bash", "-c", match.Command)
	cmd.Dir = cwd
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		writeJSON(w, map[string]any{
			"status": "failed",
			"id":     match.ID,
			"error":  err.Error(),
			"output": strings.TrimSpace(out.String()),
		})
		return
	}
	writeJSON(w, map[string]any{
		"status": "ran",
		"id":     match.ID,
		"output": strings.TrimSpace(out.String()),
		"cwd":    cwd,
	})
}

// lookupInstalledPlugin returns the installed Plugin record for
// (agent, plugin, marketplace) plus the agent's claudeDir. Errors
// when the agent doesn't exist or the plugin isn't installed there.
func lookupInstalledPlugin(agentID, name, marketplace string) (*Plugin, string, error) {
	all, err := loadAllAgents()
	if err != nil {
		return nil, "", err
	}
	var a *Agent
	for i := range all {
		if all[i].ID == agentID {
			a = &all[i]
			break
		}
	}
	if a == nil {
		return nil, "", fmt.Errorf("no such agent")
	}
	dir, _, _ := effectiveClaudeDir(*a, all)
	if dir == "" {
		return nil, "", fmt.Errorf("no CLAUDE_CONFIG_DIR for agent")
	}
	plugins := scanInstalledPluginsForAgent(dir, agentID)
	for i := range plugins {
		if plugins[i].Name == name && plugins[i].Marketplace == marketplace {
			return &plugins[i], dir, nil
		}
	}
	return nil, "", fmt.Errorf("plugin %s@%s not installed", name, marketplace)
}

// agentCwd returns the working directory the agent runs in. Used as
// the script execution cwd so setup commands like "mkdir memory/topics"
// land in the orch's project, not fleetview's.
func agentCwd(agentID string) (string, error) {
	all, err := loadAllAgents()
	if err != nil {
		return "", err
	}
	for _, a := range all {
		if a.ID == agentID && a.Cwd != "" {
			return a.Cwd, nil
		}
	}
	return "", fmt.Errorf("agent has no recorded cwd")
}
