// Messaging integration: Telegram + iMessage inbound, both routed to
// the `director` dispatcher via `roster notify`. State persists in
// ~/.local/share/director/messaging.json; secrets (Telegram bot token)
// live in the macOS Keychain so they survive disk wipes.
//
// Outbound (sending replies back) is intentionally out of scope for
// v1 — see docs/messaging.md for the v2 plan.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// --- state ----------------------------------------------------------------

type messagingState struct {
	Telegram telegramState `json:"telegram"`
	IMessage imessageState `json:"imessage"`

	// Active reply target — the channel the dispatcher should reply
	// to when it produces an assistant message. Set by the most
	// recent external inbound. Cleared on disconnect.
	ActiveSource     string    `json:"active_source,omitempty"` // "telegram" | "imessage" | ""
	ActiveSetAt      time.Time `json:"active_set_at,omitempty"`
	ActiveTGChatID   int64     `json:"active_tg_chat_id,omitempty"`
	ActiveIMHandle   string    `json:"active_im_handle,omitempty"`
	LastOutboundTime time.Time `json:"last_outbound_time,omitempty"` // watermark for the director-message poller
}

type telegramState struct {
	Connected    bool   `json:"connected"`
	BotUsername  string `json:"bot_username,omitempty"`
	BotID        int64  `json:"bot_id,omitempty"`
	ChatID       int64  `json:"chat_id,omitempty"`
	LastUpdateID int64  `json:"last_update_id,omitempty"`
}

type imessageState struct {
	Watching   bool  `json:"watching"`
	LastRowID  int64 `json:"last_rowid,omitempty"`
	HandleOnly bool  `json:"handle_only,omitempty"` // future: filter by handle
}

// messagingRuntime owns mutable state + the running poller goroutines.
type messagingRuntime struct {
	mu             sync.Mutex
	state          messagingState
	tgCancel       context.CancelFunc
	imsgCancel     context.CancelFunc
	outboundCancel context.CancelFunc
}

var messaging = &messagingRuntime{}

func messagingStatePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "director", "messaging.json")
}

func (m *messagingRuntime) load() {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := os.ReadFile(messagingStatePath())
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, &m.state)
}

// save persists state under the caller's lock.
func (m *messagingRuntime) save() error {
	path := messagingStatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// snapshot returns a copy of state for read-only consumers.
func (m *messagingRuntime) snapshot() messagingState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// --- keychain (separate service from per-agent plugin secrets) ------------

const (
	messagingKeychainService = "Director-Messaging"
	keyTelegramBotToken      = "telegram-bot-token"
)

func messagingKeychainGet(account string) (string, error) {
	out, err := exec.Command("/usr/bin/security",
		"find-generic-password",
		"-s", messagingKeychainService,
		"-a", account,
		"-w",
	).Output()
	if err != nil {
		return "", nil // not found
	}
	return strings.TrimSpace(string(out)), nil
}

func messagingKeychainSet(account, value string) error {
	cmd := exec.Command("/usr/bin/security",
		"add-generic-password",
		"-U",
		"-s", messagingKeychainService,
		"-a", account,
		"-w", value,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("keychain write: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func messagingKeychainDelete(account string) {
	_ = exec.Command("/usr/bin/security",
		"delete-generic-password",
		"-s", messagingKeychainService,
		"-a", account,
	).Run()
}

// --- inbound routing ------------------------------------------------------

// routeInbound delivers a message to the dispatcher as if the user had
// typed it. We prefix with [source from sender] so the dispatcher's
// LLM can use the source/sender as routing context. Also marks this
// source as the active reply target so the outbound poller knows
// where to send director's response.
func routeInbound(source, sender, text string) error {
	body := strings.TrimSpace(text)
	if body == "" {
		return nil
	}
	prefixed := fmt.Sprintf("[%s from %s] %s", source, sender, body)
	cmd := exec.Command(rosterBin, "notify", "director", prefixed, "--from", source)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("notify director: %s", strings.TrimSpace(string(out)))
	}

	// Set active source AFTER successful notify — if delivery failed,
	// don't redirect future replies to a channel we can't actually
	// reach.
	messaging.mu.Lock()
	messaging.state.ActiveSource = source
	messaging.state.ActiveSetAt = time.Now()
	// Reset the outbound watermark to "now" so we only forward
	// assistant messages produced AFTER this inbound. Otherwise an
	// hour-old reply still in the JSONL could bounce out.
	messaging.state.LastOutboundTime = time.Now()
	_ = messaging.save()
	messaging.mu.Unlock()
	return nil
}

// --- HTTP handlers --------------------------------------------------------

// handleMessagingStatus returns connection state for both providers.
// UI polls this to render the MessagingPanel.
func handleMessagingStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, messaging.snapshot())
}

// handleMessagingTelegramConnect accepts {bot_token}, validates via
// Telegram getMe, stores token in Keychain, and starts the poller.
func handleMessagingTelegramConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		BotToken string `json:"bot_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token := strings.TrimSpace(body.BotToken)
	if token == "" {
		http.Error(w, "bot_token required", http.StatusBadRequest)
		return
	}

	bot, err := telegramGetMe(token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := messagingKeychainSet(keyTelegramBotToken, token); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	messaging.mu.Lock()
	messaging.state.Telegram = telegramState{
		Connected:    true,
		BotUsername:  bot.Username,
		BotID:        bot.ID,
		LastUpdateID: messaging.state.Telegram.LastUpdateID, // preserve cursor across reconnect
	}
	if err := messaging.save(); err != nil {
		messaging.mu.Unlock()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	messaging.mu.Unlock()

	messagingStartTelegram()
	messagingStartOutbound()

	writeJSON(w, messaging.snapshot().Telegram)
}

// handleMessagingTelegramDisconnect stops the poller, clears state,
// and removes the bot token from the Keychain.
func handleMessagingTelegramDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	messagingStopTelegram()
	messagingKeychainDelete(keyTelegramBotToken)

	messaging.mu.Lock()
	messaging.state.Telegram = telegramState{}
	if messaging.state.ActiveSource == "telegram" {
		messaging.state.ActiveSource = ""
		messaging.state.ActiveTGChatID = 0
	}
	_ = messaging.save()
	imsgWatching := messaging.state.IMessage.Watching
	messaging.mu.Unlock()

	if !imsgWatching {
		messagingStopOutbound()
	}

	writeJSON(w, map[string]string{"status": "disconnected"})
}

// handleMessagingIMessageStart enables iMessage watching after the
// caller has confirmed Full Disk Access. We re-check FDA here so a
// stale toggle from the UI doesn't silently fail.
func handleMessagingIMessageStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := imessageCheckAccess(); err != nil {
		http.Error(w, err.Error(), http.StatusPreconditionFailed)
		return
	}

	messaging.mu.Lock()
	if messaging.state.IMessage.LastRowID == 0 {
		// First-time start: skip the entire backlog. Otherwise we'd
		// dump the user's whole message history into the dispatcher.
		if rowid, err := imessageMaxRowID(); err == nil {
			messaging.state.IMessage.LastRowID = rowid
		}
	}
	messaging.state.IMessage.Watching = true
	if err := messaging.save(); err != nil {
		messaging.mu.Unlock()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	messaging.mu.Unlock()

	messagingStartIMessage()
	messagingStartOutbound()
	writeJSON(w, messaging.snapshot().IMessage)
}

func handleMessagingIMessageStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	messagingStopIMessage()
	messaging.mu.Lock()
	messaging.state.IMessage.Watching = false
	if messaging.state.ActiveSource == "imessage" {
		messaging.state.ActiveSource = ""
		messaging.state.ActiveIMHandle = ""
	}
	_ = messaging.save()
	tgConnected := messaging.state.Telegram.Connected
	messaging.mu.Unlock()

	if !tgConnected {
		messagingStopOutbound()
	}

	writeJSON(w, map[string]string{"status": "stopped"})
}

// handleMessagingIMessageCheck reports prerequisite status (FDA, Messages.app)
// without trying to start anything. UI uses this to render the checklist.
func handleMessagingIMessageCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	resp := map[string]any{
		"full_disk_access":   imessageCheckAccess() == nil,
		"messages_app_ready": imessageMessagesAppReady(),
	}
	writeJSON(w, resp)
}

// handleMessagingOpenURL opens a URL using the macOS `open` command.
// This is the escape hatch for URL schemes (x-apple.systempreferences,
// macappstore, etc) that the Wails webview refuses to handle from
// window.open. Body: {"url": "x-apple.systempreferences:..."}.
func handleMessagingOpenURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Allowlist URL schemes — refuse anything else so a future bug
	// can't turn this into a generic "open arbitrary URL" gadget.
	if !strings.HasPrefix(body.URL, "x-apple.systempreferences:") &&
		!strings.HasPrefix(body.URL, "https://") &&
		!strings.HasPrefix(body.URL, "http://") {
		http.Error(w, "unsupported url scheme", http.StatusBadRequest)
		return
	}
	if err := exec.Command("/usr/bin/open", body.URL).Start(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "opened"})
}

// --- boot orchestration ---------------------------------------------------

// messagingBoot resumes any pollers that were running before the last
// shutdown. Called from main() after rosterBin is set.
func messagingBoot() {
	messaging.load()
	state := messaging.snapshot()

	if state.Telegram.Connected {
		if token, _ := messagingKeychainGet(keyTelegramBotToken); token != "" {
			messagingStartTelegram()
		} else {
			// State says connected but token's gone (keychain wiped, etc).
			// Mark disconnected so the UI doesn't lie.
			messaging.mu.Lock()
			messaging.state.Telegram.Connected = false
			_ = messaging.save()
			messaging.mu.Unlock()
		}
	}
	if state.IMessage.Watching {
		messagingStartIMessage()
	}
	// Outbound poller runs whenever any source is connected — it
	// only fires when there's somewhere to send.
	if state.Telegram.Connected || state.IMessage.Watching {
		messagingStartOutbound()
	}
}

// messagingShutdown stops all pollers. Called from app exit (best-effort).
func messagingShutdown() {
	messagingStopTelegram()
	messagingStopIMessage()
	messagingStopOutbound()
}
