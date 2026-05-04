package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const telegramAPI = "https://api.telegram.org"

// --- API types ------------------------------------------------------------

type telegramUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	IsBot     bool   `json:"is_bot"`
}

type telegramChat struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title,omitempty"`
	Username  string `json:"username,omitempty"`
	FirstName string `json:"first_name,omitempty"`
}

type telegramMessage struct {
	MessageID int64        `json:"message_id"`
	From      telegramUser `json:"from"`
	Chat      telegramChat `json:"chat"`
	Date      int64        `json:"date"`
	Text      string       `json:"text"`
}

type telegramUpdate struct {
	UpdateID int64           `json:"update_id"`
	Message  telegramMessage `json:"message"`
}

type telegramAPIResp struct {
	OK          bool            `json:"ok"`
	ErrorCode   int             `json:"error_code,omitempty"`
	Description string          `json:"description,omitempty"`
	Result      json.RawMessage `json:"result"`
}

// --- API calls ------------------------------------------------------------

// telegramGetMe validates a bot token. Used at connect time.
func telegramGetMe(token string) (*telegramUser, error) {
	resp, err := telegramCall(token, "getMe", nil)
	if err != nil {
		return nil, err
	}
	var bot telegramUser
	if err := json.Unmarshal(resp, &bot); err != nil {
		return nil, fmt.Errorf("getMe parse: %w", err)
	}
	if !bot.IsBot {
		return nil, fmt.Errorf("token is for a user, not a bot")
	}
	return &bot, nil
}

// telegramCall is a thin form-encoded POST wrapper.
func telegramCall(token, method string, params url.Values) (json.RawMessage, error) {
	endpoint := fmt.Sprintf("%s/bot%s/%s", telegramAPI, token, method)
	var body io.Reader
	contentType := ""
	if params != nil {
		body = strings.NewReader(params.Encode())
		contentType = "application/x-www-form-urlencoded"
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed telegramAPIResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("telegram %s: parse: %w (body: %s)", method, err, string(raw))
	}
	if !parsed.OK {
		return nil, fmt.Errorf("telegram %s: %s", method, parsed.Description)
	}
	return parsed.Result, nil
}

// --- poller ---------------------------------------------------------------

// messagingStartTelegram launches the long-poll loop. Idempotent —
// stops any existing loop first.
func messagingStartTelegram() {
	messaging.mu.Lock()
	if messaging.tgCancel != nil {
		messaging.tgCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	messaging.tgCancel = cancel
	messaging.mu.Unlock()

	go telegramPollLoop(ctx)
}

func messagingStopTelegram() {
	messaging.mu.Lock()
	defer messaging.mu.Unlock()
	if messaging.tgCancel != nil {
		messaging.tgCancel()
		messaging.tgCancel = nil
	}
}

// telegramPollLoop runs getUpdates with long-poll timeout=30s. Exits
// only when the context is cancelled. Network errors trigger a short
// backoff so transient outages don't spin the CPU.
func telegramPollLoop(ctx context.Context) {
	const longPollSeconds = 30

	for {
		if ctx.Err() != nil {
			return
		}
		token, _ := messagingKeychainGet(keyTelegramBotToken)
		if token == "" {
			// Token disappeared — reflect that in state and bail.
			messaging.mu.Lock()
			messaging.state.Telegram.Connected = false
			_ = messaging.save()
			messaging.mu.Unlock()
			return
		}

		offset := messaging.snapshot().Telegram.LastUpdateID + 1
		params := url.Values{}
		params.Set("offset", strconv.FormatInt(offset, 10))
		params.Set("timeout", strconv.Itoa(longPollSeconds))
		params.Set("allowed_updates", `["message"]`)

		raw, err := telegramCall(token, "getUpdates", params)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("telegram getUpdates: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}

		var updates []telegramUpdate
		if err := json.Unmarshal(raw, &updates); err != nil {
			log.Printf("telegram updates parse: %v", err)
			continue
		}
		for _, u := range updates {
			telegramHandleUpdate(u)
		}
	}
}

// telegramHandleUpdate processes a single update: sets chat ID on
// first message, advances the cursor, routes text to the dispatcher.
func telegramHandleUpdate(u telegramUpdate) {
	// Always advance the cursor, even on non-text updates, so we don't
	// re-fetch the same payload on the next poll.
	messaging.mu.Lock()
	if u.UpdateID > messaging.state.Telegram.LastUpdateID {
		messaging.state.Telegram.LastUpdateID = u.UpdateID
	}
	if messaging.state.Telegram.ChatID == 0 && u.Message.Chat.ID != 0 {
		// First inbound — pin this chat as our authorized source.
		messaging.state.Telegram.ChatID = u.Message.Chat.ID
	}
	authorizedChat := messaging.state.Telegram.ChatID
	_ = messaging.save()
	messaging.mu.Unlock()

	if u.Message.MessageID == 0 || u.Message.Text == "" {
		return // non-text update (sticker, photo, etc) — skip for v1
	}
	if u.Message.Chat.ID != authorizedChat {
		// Message from an unauthorized chat. Ignore — we only follow
		// the first chat that messages the bot. The user can reset
		// this by disconnecting and reconnecting.
		return
	}

	sender := u.Message.From.Username
	if sender == "" {
		sender = u.Message.From.FirstName
	}
	if sender == "" {
		sender = strconv.FormatInt(u.Message.From.ID, 10)
	}
	// Pin this chat as the reply target before notifying — routeInbound
	// sets ActiveSource but doesn't know the per-source coordinates.
	messaging.mu.Lock()
	messaging.state.ActiveTGChatID = u.Message.Chat.ID
	_ = messaging.save()
	messaging.mu.Unlock()

	if err := routeInbound("telegram", "@"+sender, u.Message.Text); err != nil {
		log.Printf("telegram route to dispatcher: %v", err)
	}
}
