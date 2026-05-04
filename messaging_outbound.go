package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const outboundPollInterval = 1500 * time.Millisecond

// messagingStartOutbound launches the director-message poller. Idempotent.
func messagingStartOutbound() {
	messaging.mu.Lock()
	if messaging.outboundCancel != nil {
		messaging.outboundCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	messaging.outboundCancel = cancel
	messaging.mu.Unlock()

	go outboundPollLoop(ctx)
}

func messagingStopOutbound() {
	messaging.mu.Lock()
	defer messaging.mu.Unlock()
	if messaging.outboundCancel != nil {
		messaging.outboundCancel()
		messaging.outboundCancel = nil
	}
}

// outboundPollLoop watches the director dispatcher's message stream
// for new assistant text. Each fresh message is forwarded to whichever
// external channel was the most recent inbound (ActiveSource).
//
// Watermark is the timestamp of the most recently forwarded message,
// not message id — JSONL has no stable id and timestamps are monotonic
// within a single session.
func outboundPollLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := outboundScanOnce(); err != nil {
			log.Printf("messaging outbound: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(outboundPollInterval):
		}
	}
}

func outboundScanOnce() error {
	state := messaging.snapshot()
	if state.ActiveSource == "" {
		return nil // nothing to forward to
	}

	// Find the dispatcher and its JSONL path.
	dispatcher, err := loadAgentMerged("director")
	if err != nil {
		return err
	}
	if dispatcher == nil || dispatcher.JSONLPath == "" {
		return nil // not started yet
	}

	msgs, err := parseMessages(dispatcher.JSONLPath)
	if err != nil {
		return err
	}

	watermark := state.LastOutboundTime
	var newest time.Time
	var pending []string
	for _, m := range msgs {
		if m.Role != "assistant" {
			continue
		}
		if m.Thinking {
			continue
		}
		if strings.TrimSpace(m.Text) == "" {
			continue
		}
		if !m.Time.After(watermark) {
			continue
		}
		pending = append(pending, m.Text)
		if m.Time.After(newest) {
			newest = m.Time
		}
	}
	if len(pending) == 0 {
		return nil
	}

	// Send before advancing the watermark — if a send fails we want
	// to retry on the next poll, not drop the message.
	for _, text := range pending {
		if err := outboundSend(state, text); err != nil {
			return fmt.Errorf("send to %s: %w", state.ActiveSource, err)
		}
	}

	messaging.mu.Lock()
	if newest.After(messaging.state.LastOutboundTime) {
		messaging.state.LastOutboundTime = newest
		_ = messaging.save()
	}
	messaging.mu.Unlock()
	return nil
}

func outboundSend(state messagingState, text string) error {
	switch state.ActiveSource {
	case "telegram":
		if state.ActiveTGChatID == 0 {
			return fmt.Errorf("active_tg_chat_id is empty")
		}
		return telegramSendMessage(state.ActiveTGChatID, text)
	case "imessage":
		if state.ActiveIMHandle == "" {
			return fmt.Errorf("active_im_handle is empty")
		}
		return imessageSendMessage(state.ActiveIMHandle, text)
	default:
		return fmt.Errorf("unknown active source: %s", state.ActiveSource)
	}
}

// --- Telegram send --------------------------------------------------------

func telegramSendMessage(chatID int64, text string) error {
	token, err := messagingKeychainGet(keyTelegramBotToken)
	if err != nil {
		return err
	}
	if token == "" {
		return fmt.Errorf("no telegram bot token in keychain")
	}
	params := url.Values{}
	params.Set("chat_id", strconv.FormatInt(chatID, 10))
	params.Set("text", text)
	// disable_web_page_preview — agent text often contains URLs that
	// would otherwise produce noisy preview cards.
	params.Set("disable_web_page_preview", "true")
	_, err = telegramCall(token, "sendMessage", params)
	return err
}

// --- iMessage send via AppleScript ----------------------------------------

// imessageSendMessage sends `text` to `handle` (a phone number,
// email, or display name) using the macOS Messages.app's iMessage
// service. Falls back to SMS if iMessage routing fails — Messages.app
// handles that decision based on the recipient's account.
//
// The AppleScript here builds the message via osascript -e; we
// double-quote the text and escape backslashes + double quotes so a
// reply containing a `"` or `\` doesn't break the script. Newlines in
// the text are replaced with `\n` because AppleScript string literals
// can't span lines. Multi-line replies arrive as one iMessage with
// embedded line breaks rendered correctly on the recipient side.
func imessageSendMessage(handle, text string) error {
	escaped := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
	).Replace(text)

	script := fmt.Sprintf(`
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy %q of targetService
    send "%s" to targetBuddy
end tell
`, handle, escaped)

	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("osascript: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
