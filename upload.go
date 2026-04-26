package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// File attachments dropped or picked in the notify box land here.
// Each upload writes the file to a per-agent dir under the user's
// home, returns the saved path. The UI then includes that path in
// the outgoing notify message so the recipient orch can Read() it.
//
//   <home>/.local/share/roster/uploads/<agent-id>/<timestamp>-<rand>-<safe-name>

const maxUploadBytes = 50 * 1024 * 1024 // 50MB; raised when we hit a real limit

type uploadReply struct {
	Path     string `json:"path"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Media    string `json:"media_type,omitempty"`
}

func handleUpload(w http.ResponseWriter, r *http.Request, agentID string) {
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, "parse: "+err.Error(), http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "form file 'file' missing: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	dir, err := uploadsDirFor(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, uploadFilename(header.Filename))
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer out.Close()
	n, err := io.Copy(out, file)
	if err != nil {
		_ = os.Remove(dst)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	media := header.Header.Get("Content-Type")
	if media == "" {
		media = guessMediaType(header.Filename)
	}
	writeJSON(w, uploadReply{
		Path:     dst,
		Filename: header.Filename,
		Size:     n,
		Media:    media,
	})
}

func uploadsDirFor(agentID string) (string, error) {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		return filepath.Join(filepath.Dir(d), "uploads", agentID), nil
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "uploads", agentID), nil
}

// uploadFilename produces "<ts>-<rand>-<safe>". Timestamp gives ordering
// in `ls`, the random suffix avoids collisions on the same second, and
// sanitization strips path separators / control chars from the user's
// filename without losing the extension (which downstream tools care
// about for image sniffing).
func uploadFilename(orig string) string {
	ts := time.Now().UTC().Format("20060102-150405")
	var rb [4]byte
	_, _ = rand.Read(rb[:])
	suffix := hex.EncodeToString(rb[:])
	return fmt.Sprintf("%s-%s-%s", ts, suffix, sanitizeFilename(orig))
}

func sanitizeFilename(s string) string {
	if s == "" {
		return "upload"
	}
	s = filepath.Base(s)
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '/' || c == '\\' || c == 0:
			// drop
		case c < 0x20:
			// drop control chars
		default:
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return "upload"
	}
	return string(out)
}

func guessMediaType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".pdf":
		return "application/pdf"
	case ".txt", ".md":
		return "text/plain"
	case ".json":
		return "application/json"
	}
	return "application/octet-stream"
}
