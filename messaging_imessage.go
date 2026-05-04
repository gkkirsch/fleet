package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	imessagePollInterval = 3 * time.Second
	imessageRowDelimiter = "\x1f" // ASCII unit separator — never appears in real text/handles
)

func imessageDBPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Messages", "chat.db")
}

// imessageCheckAccess returns nil iff we can open chat.db read-only.
// macOS rejects the read with operation-not-permitted unless the
// running app has Full Disk Access; we surface that as a typed error.
func imessageCheckAccess() error {
	path := imessageDBPath()
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("messages database not found at %s — is Messages.app signed in?", path)
	}
	out, err := exec.Command("/usr/bin/sqlite3", "-readonly", path,
		"SELECT 1 FROM message LIMIT 1;",
	).CombinedOutput()
	if err != nil {
		s := strings.TrimSpace(string(out))
		if strings.Contains(s, "authorization denied") ||
			strings.Contains(s, "unable to open") ||
			strings.Contains(s, "operation not permitted") {
			return fmt.Errorf("Director needs Full Disk Access. Open System Settings → Privacy & Security → Full Disk Access and toggle Director on, then relaunch the app")
		}
		return fmt.Errorf("sqlite3: %s", s)
	}
	return nil
}

// imessageMessagesAppReady is a softer probe: chat.db exists and has
// at least one chat row, suggesting Messages.app has been signed in.
func imessageMessagesAppReady() bool {
	out, err := exec.Command("/usr/bin/sqlite3", "-readonly", imessageDBPath(),
		"SELECT COUNT(*) FROM chat;",
	).Output()
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	return err == nil && n > 0
}

// imessageMaxRowID returns the highest message rowid currently in the
// db. Used to fast-forward past the user's history on first start so
// we don't dump the whole archive into the dispatcher.
func imessageMaxRowID() (int64, error) {
	out, err := exec.Command("/usr/bin/sqlite3", "-readonly", imessageDBPath(),
		"SELECT COALESCE(MAX(rowid), 0) FROM message;",
	).Output()
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
}

// --- poller ---------------------------------------------------------------

func messagingStartIMessage() {
	messaging.mu.Lock()
	if messaging.imsgCancel != nil {
		messaging.imsgCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	messaging.imsgCancel = cancel
	messaging.mu.Unlock()

	go imessagePollLoop(ctx)
}

func messagingStopIMessage() {
	messaging.mu.Lock()
	defer messaging.mu.Unlock()
	if messaging.imsgCancel != nil {
		messaging.imsgCancel()
		messaging.imsgCancel = nil
	}
}

func imessagePollLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := imessageScanOnce(); err != nil {
			log.Printf("imessage scan: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(imessagePollInterval):
		}
	}
}

// imessageScanOnce reads any rows newer than LastRowID. Output is
// emitted as one row per line, fields joined by an ASCII unit
// separator that won't collide with text or handle content.
func imessageScanOnce() error {
	last := messaging.snapshot().IMessage.LastRowID

	// is_from_me=0 filters out our own outgoing messages so we don't
	// echo our replies back through the dispatcher. Skip rows with
	// NULL text (image-only, taps, etc) — we don't have media handling
	// in v1.
	query := fmt.Sprintf(`
		.separator "%s" "\n"
		SELECT m.rowid, COALESCE(h.id, ''), m.text
		FROM message m
		LEFT JOIN handle h ON m.handle_id = h.rowid
		WHERE m.rowid > %d
		  AND m.is_from_me = 0
		  AND m.text IS NOT NULL
		ORDER BY m.rowid;
	`, imessageRowDelimiter, last)

	cmd := exec.Command("/usr/bin/sqlite3", "-readonly", imessageDBPath())
	cmd.Stdin = strings.NewReader(query)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sqlite3: %s", strings.TrimSpace(stderr.String()))
	}

	scanner := bufio.NewScanner(&stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // long messages
	maxSeen := last
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, imessageRowDelimiter, 3)
		if len(parts) < 3 {
			continue
		}
		rowid, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue
		}
		sender := parts[1]
		if sender == "" {
			sender = "unknown"
		}
		text := strings.TrimSpace(parts[2])
		if text == "" {
			// is_from_me=0 + null text already filtered; this catches
			// the rare empty-string case.
			if rowid > maxSeen {
				maxSeen = rowid
			}
			continue
		}
		// Pin this handle as the reply target so the outbound poller
		// knows where to send director's response.
		messaging.mu.Lock()
		messaging.state.ActiveIMHandle = sender
		_ = messaging.save()
		messaging.mu.Unlock()

		if err := routeInbound("imessage", sender, text); err != nil {
			log.Printf("imessage route to dispatcher: %v", err)
			// Don't advance past this row — retry on next scan.
			break
		}
		if rowid > maxSeen {
			maxSeen = rowid
		}
	}

	if maxSeen > last {
		messaging.mu.Lock()
		if maxSeen > messaging.state.IMessage.LastRowID {
			messaging.state.IMessage.LastRowID = maxSeen
			_ = messaging.save()
		}
		messaging.mu.Unlock()
	}
	return nil
}
