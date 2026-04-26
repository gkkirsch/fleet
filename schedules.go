package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Per-orch scheduled tasks. Claude Code reads these natively from
// <CLAUDE_CONFIG_DIR>/scheduled_tasks.json and fires the prompts when
// their cron matches; fleetview here only does CRUD on that file so
// the user can add / list / remove durable jobs through the dashboard.
//
// Shape on disk matches Claude Code's expected schema (also matches
// superbot3's broker so we don't reinvent):
//
//   { "tasks": [
//       { "id": "abc12345", "cron": "0 9 * * 1-5", "prompt": "...",
//         "createdAt": 1735689600000, "recurring": true,
//         "permanent": true }
//     ] }
//
// `createdAt` is milliseconds since epoch (matches what Claude Code
// writes; superbot3 followed that convention).

type Schedule struct {
	ID        string `json:"id"`
	Cron      string `json:"cron"`
	Prompt    string `json:"prompt"`
	CreatedAt int64  `json:"createdAt"`
	Recurring bool   `json:"recurring"`
	Permanent bool   `json:"permanent"`
	HumanCron string `json:"humanCron,omitempty"`
}

type scheduleFile struct {
	Tasks []Schedule `json:"tasks"`
}

type scheduleListReply struct {
	Tasks []Schedule `json:"tasks"`
}

func schedulesPathFor(orchID string) string {
	d := orchClaudeDirOnDisk(orchID)
	if d == "" {
		return ""
	}
	return filepath.Join(d, "scheduled_tasks.json")
}

func readScheduleFile(path string) (scheduleFile, error) {
	if path == "" {
		return scheduleFile{}, fmt.Errorf("could not resolve schedules path")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return scheduleFile{Tasks: []Schedule{}}, nil
		}
		return scheduleFile{}, err
	}
	var sf scheduleFile
	if err := json.Unmarshal(b, &sf); err != nil {
		return scheduleFile{}, err
	}
	if sf.Tasks == nil {
		sf.Tasks = []Schedule{}
	}
	return sf, nil
}

func writeScheduleFile(path string, sf scheduleFile) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(path, out, 0o644)
}

func newScheduleID() string {
	var rb [4]byte
	_, _ = rand.Read(rb[:])
	return hex.EncodeToString(rb[:])
}

func enrich(tasks []Schedule) []Schedule {
	out := make([]Schedule, len(tasks))
	for i, t := range tasks {
		t.HumanCron = cronToHuman(t.Cron)
		out[i] = t
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

// --- HTTP -------------------------------------------------------------------

// handleSchedules dispatches to list / create / update / delete.
//
//	tail = ""      GET list, POST create
//	tail = "/<id>" PATCH update, DELETE remove
func handleSchedules(w http.ResponseWriter, r *http.Request, orchID, tail string) {
	tail = strings.TrimPrefix(tail, "/")
	if tail == "" {
		switch r.Method {
		case http.MethodGet:
			handleSchedulesList(w, orchID)
		case http.MethodPost:
			handleSchedulesCreate(w, r, orchID)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
		return
	}
	switch r.Method {
	case http.MethodDelete:
		handleSchedulesDelete(w, orchID, tail)
	case http.MethodPatch, http.MethodPut:
		handleSchedulesUpdate(w, r, orchID, tail)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func handleSchedulesList(w http.ResponseWriter, orchID string) {
	sf, err := readScheduleFile(schedulesPathFor(orchID))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, scheduleListReply{Tasks: enrich(sf.Tasks)})
}

type createScheduleReq struct {
	Cron      string `json:"cron"`
	Prompt    string `json:"prompt"`
	Recurring *bool  `json:"recurring,omitempty"`
}

func handleSchedulesCreate(w http.ResponseWriter, r *http.Request, orchID string) {
	var body createScheduleReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	body.Cron = strings.TrimSpace(body.Cron)
	body.Prompt = strings.TrimSpace(body.Prompt)
	if body.Cron == "" || body.Prompt == "" {
		http.Error(w, "cron and prompt are required", http.StatusBadRequest)
		return
	}
	path := schedulesPathFor(orchID)
	if path == "" {
		http.Error(w, "could not resolve schedules path", http.StatusInternalServerError)
		return
	}
	sf, err := readScheduleFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rec := true
	if body.Recurring != nil {
		rec = *body.Recurring
	}
	t := Schedule{
		ID:        newScheduleID(),
		Cron:      body.Cron,
		Prompt:    body.Prompt,
		CreatedAt: time.Now().UnixMilli(),
		Recurring: rec,
		Permanent: true,
	}
	sf.Tasks = append(sf.Tasks, t)
	if err := writeScheduleFile(path, sf); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	t.HumanCron = cronToHuman(t.Cron)
	writeJSON(w, t)
}

type updateScheduleReq struct {
	Cron      *string `json:"cron,omitempty"`
	Prompt    *string `json:"prompt,omitempty"`
	Recurring *bool   `json:"recurring,omitempty"`
}

func handleSchedulesUpdate(w http.ResponseWriter, r *http.Request, orchID, taskID string) {
	var body updateScheduleReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	path := schedulesPathFor(orchID)
	sf, err := readScheduleFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	idx := -1
	for i, t := range sf.Tasks {
		if t.ID == taskID {
			idx = i
			break
		}
	}
	if idx < 0 {
		http.Error(w, "no such task", http.StatusNotFound)
		return
	}
	if body.Cron != nil {
		c := strings.TrimSpace(*body.Cron)
		if c == "" {
			http.Error(w, "cron cannot be empty", http.StatusBadRequest)
			return
		}
		sf.Tasks[idx].Cron = c
	}
	if body.Prompt != nil {
		p := strings.TrimSpace(*body.Prompt)
		if p == "" {
			http.Error(w, "prompt cannot be empty", http.StatusBadRequest)
			return
		}
		sf.Tasks[idx].Prompt = p
	}
	if body.Recurring != nil {
		sf.Tasks[idx].Recurring = *body.Recurring
	}
	if err := writeScheduleFile(path, sf); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	t := sf.Tasks[idx]
	t.HumanCron = cronToHuman(t.Cron)
	writeJSON(w, t)
}

func handleSchedulesDelete(w http.ResponseWriter, orchID, taskID string) {
	path := schedulesPathFor(orchID)
	sf, err := readScheduleFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	before := len(sf.Tasks)
	out := sf.Tasks[:0]
	for _, t := range sf.Tasks {
		if t.ID != taskID {
			out = append(out, t)
		}
	}
	sf.Tasks = out
	if len(sf.Tasks) == before {
		http.Error(w, "no such task", http.StatusNotFound)
		return
	}
	if err := writeScheduleFile(path, sf); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// --- cronToHuman ------------------------------------------------------------
//
// Port of superbot3 / Claude Code's cron-to-human helper. Only the
// shapes the UI's frequency picker generates are recognized; anything
// fancier returns the raw cron expression unchanged.

var dayNames = [...]string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

var (
	reEveryNMin  = regexp.MustCompile(`^\*/(\d+)$`)
	reEveryNHour = regexp.MustCompile(`^\*/(\d+)$`)
	reAllDigits  = regexp.MustCompile(`^\d+$`)
	reHoursList  = regexp.MustCompile(`^[\d,]+$`)
)

func cronToHuman(cron string) string {
	parts := strings.Fields(strings.TrimSpace(cron))
	if len(parts) != 5 {
		return cron
	}
	minute, hour, dom, mon, dow := parts[0], parts[1], parts[2], parts[3], parts[4]

	// One-shot date-locked: M H DoM Mon * (single numeric day + month).
	// Render as "Apr 26 at 5:00 PM" so the user sees when it fires.
	if reAllDigits.MatchString(minute) && reAllDigits.MatchString(hour) &&
		reAllDigits.MatchString(dom) && reAllDigits.MatchString(mon) && dow == "*" {
		mm, _ := strconv.Atoi(minute)
		hh, _ := strconv.Atoi(hour)
		d, _ := strconv.Atoi(dom)
		mo, _ := strconv.Atoi(mon)
		if mo >= 1 && mo <= 12 {
			month := time.Month(mo)
			return fmt.Sprintf("%s %d at %s", month.String()[:3], d, formatLocalTime(hh, mm))
		}
	}

	// */N * * * *
	if m := reEveryNMin.FindStringSubmatch(minute); m != nil &&
		hour == "*" && dom == "*" && mon == "*" && dow == "*" {
		n, _ := strconv.Atoi(m[1])
		if n == 1 {
			return "Every minute"
		}
		return fmt.Sprintf("Every %d minutes", n)
	}

	// N * * * *
	if reAllDigits.MatchString(minute) &&
		hour == "*" && dom == "*" && mon == "*" && dow == "*" {
		mm, _ := strconv.Atoi(minute)
		if mm == 0 {
			return "Every hour"
		}
		return fmt.Sprintf("Every hour at :%02d", mm)
	}

	// M */N * * *
	if reAllDigits.MatchString(minute) {
		if m := reEveryNHour.FindStringSubmatch(hour); m != nil &&
			dom == "*" && mon == "*" && dow == "*" {
			n, _ := strconv.Atoi(m[1])
			mm, _ := strconv.Atoi(minute)
			suffix := ""
			if mm != 0 {
				suffix = fmt.Sprintf(" at :%02d", mm)
			}
			if n == 1 {
				return "Every hour" + suffix
			}
			return fmt.Sprintf("Every %d hours%s", n, suffix)
		}
	}

	// remaining cases need numeric minute + hour-list
	if !reAllDigits.MatchString(minute) || !reHoursList.MatchString(hour) {
		return cron
	}
	mm, _ := strconv.Atoi(minute)

	hourList := strings.Split(hour, ",")
	hours := make([]int, 0, len(hourList))
	for _, h := range hourList {
		hi, err := strconv.Atoi(h)
		if err != nil {
			return cron
		}
		hours = append(hours, hi)
	}

	switch {
	// Daily: M H * * *
	case dom == "*" && mon == "*" && dow == "*":
		return "Every day at " + formatTimes(mm, hours)
	// Weekdays: M H * * 1-5
	case dom == "*" && mon == "*" && dow == "1-5":
		return "Weekdays at " + formatTimes(mm, hours)
	// Specific day of week: M H * * D
	case dom == "*" && mon == "*" && len(dow) == 1 && reAllDigits.MatchString(dow):
		di, _ := strconv.Atoi(dow)
		return fmt.Sprintf("Every %s at %s", dayNames[di%7], formatTimes(mm, hours))
	}
	return cron
}

func formatTimes(minute int, hours []int) string {
	parts := make([]string, len(hours))
	for i, h := range hours {
		parts[i] = formatLocalTime(h, minute)
	}
	return strings.Join(parts, ", ")
}

func formatLocalTime(hour, minute int) string {
	suffix := "AM"
	display := hour
	switch {
	case hour == 0:
		display = 12
	case hour == 12:
		suffix = "PM"
	case hour > 12:
		display = hour - 12
		suffix = "PM"
	}
	if minute == 0 {
		return fmt.Sprintf("%d %s", display, suffix)
	}
	return fmt.Sprintf("%d:%02d %s", display, minute, suffix)
}
