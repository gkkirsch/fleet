package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Library: a per-orch file viewer over the agent's space directory.
// Each orchestrator owns <data>/<orch-id>/ where it writes artifacts,
// notes, csvs, etc. The Library panel in the UI lists what's there
// and previews individual files (text + images).
//
// Two endpoints:
//
//   GET /api/agents/:id/library?path=<rel>          → list directory
//   GET /api/agents/:id/library/file?path=<rel>     → fetch one file
//
// `path` is always relative to the orch's space root. We refuse any
// path that, after resolution, escapes the root — even via symlinks —
// so an agent that drops a symlink to /etc can't be used to read host
// files through this endpoint.

// libEntry is one row in a directory listing.
type libEntry struct {
	Name  string    `json:"name"`
	Type  string    `json:"type"` // "dir" or "file"
	Size  int64     `json:"size,omitempty"`
	MTime time.Time `json:"mtime"`
	Ext   string    `json:"ext,omitempty"`
}

// Maximum bytes we'll send in a single text-file response. Bigger
// than this we return {truncated: true} so the UI can show a notice
// instead of dragging the renderer to its knees with a 100MB log.
const maxTextBytes = 5 * 1024 * 1024 // 5 MiB

// Image extensions we stream as binary with the right Content-Type.
// Anything else is treated as either text (decodable as UTF-8) or
// "binary" (size shown, content withheld).
var imageExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".avif": "image/avif",
}

// orchSpaceDir resolves the space directory for an orch (or its
// orch ancestor for a worker). Returns "" if the agent isn't in the
// fleet or the resolved cwd is empty. Never falls back to a default
// — the caller surfaces a 404 to the UI rather than serving the data
// root by accident.
func orchSpaceDir(agentID string) (string, error) {
	all, err := loadAllAgents()
	if err != nil {
		return "", err
	}
	var a *Agent
	for i := range all {
		if all[i].ID == agentID {
			a = &all[i]
			break
		}
	}
	if a == nil {
		return "", fmt.Errorf("no such agent")
	}
	switch a.Kind {
	case "orchestrator":
		return a.Cwd, nil
	case "worker":
		anc := findOrchAncestor(a.Parent, all)
		if anc == "" {
			return "", fmt.Errorf("worker has no orchestrator ancestor")
		}
		for i := range all {
			if all[i].ID == anc {
				return all[i].Cwd, nil
			}
		}
		return "", fmt.Errorf("orch ancestor not in fleet")
	}
	return "", fmt.Errorf("agent kind %q has no library", a.Kind)
}

// safeJoin joins root and rel, then verifies the result is still
// inside root after symlink evaluation. Prevents `..` traversal and
// symlink escapes ("notes/secrets" → /etc/shadow).
func safeJoin(root, rel string) (string, error) {
	rel = strings.TrimPrefix(rel, "/")
	target := filepath.Join(root, rel)
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		// Path may not exist yet — that's a 404 the caller can surface.
		// We still need to validate the cleaned form doesn't escape.
		clean := filepath.Clean(target)
		if !isWithin(root, clean) {
			return "", fmt.Errorf("path escapes library root")
		}
		return clean, err
	}
	if !isWithin(root, resolved) {
		return "", fmt.Errorf("path escapes library root")
	}
	return resolved, nil
}

func isWithin(root, child string) bool {
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

// handleLibrary lists a directory under the orch's library.
func handleLibrary(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	root, err := orchSpaceDir(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if root == "" {
		http.Error(w, "agent has no library yet", http.StatusNotFound)
		return
	}
	rel := r.URL.Query().Get("path")
	abs, err := safeJoin(root, rel)
	if err != nil {
		// Not-exist is fine for empty directories — just return [].
		if errors.Is(err, fs.ErrNotExist) {
			writeJSON(w, []libEntry{})
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeJSON(w, []libEntry{})
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !fi.IsDir() {
		http.Error(w, "path is a file; use /library/file", http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]libEntry, 0, len(entries))
	for _, e := range entries {
		// Skip dotfiles by default — they're config noise (.git, .DS_Store)
		// not user-facing artifacts. The UI can opt in later if needed.
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		entry := libEntry{
			Name:  e.Name(),
			MTime: info.ModTime(),
		}
		if e.IsDir() {
			entry.Type = "dir"
		} else {
			entry.Type = "file"
			entry.Size = info.Size()
			entry.Ext = strings.ToLower(filepath.Ext(e.Name()))
		}
		out = append(out, entry)
	}
	// Folders first, then files; alphabetical within each group. Mirrors
	// most native file managers and makes a deeply nested tree readable.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, out)
}

// handleLibraryFile returns one file's contents. Three response shapes:
//
//   image:    binary stream with Content-Type set
//   text:     JSON {kind: "text", content: "...", truncated: bool, size: N}
//   binary:   JSON {kind: "binary", size: N} — content withheld
//
// Splitting binary vs text in the response shape keeps the React side
// simple: one `<img src=...>` for images, one `<pre>` for text, one
// "binary file" placeholder otherwise. No mime-magic in the UI.
func handleLibraryFile(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	root, err := orchSpaceDir(agentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	rel := r.URL.Query().Get("path")
	if rel == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	abs, err := safeJoin(root, rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if fi.IsDir() {
		http.Error(w, "path is a directory", http.StatusBadRequest)
		return
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if ct, ok := imageExts[ext]; ok {
		f, err := os.Open(abs)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = io.Copy(w, f)
		return
	}
	// Read up to maxTextBytes and decide text vs binary based on content.
	// 5 MiB is plenty for any conversation log / csv / md the UI cares
	// about; bigger files almost always mean "rendering this would be
	// useless anyway" so we surface size-only.
	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	buf := make([]byte, maxTextBytes+1)
	n, _ := io.ReadFull(f, buf)
	truncated := n > maxTextBytes
	if truncated {
		n = maxTextBytes
	}
	body := buf[:n]
	if !looksLikeText(body) {
		writeJSON(w, map[string]any{
			"kind": "binary",
			"size": fi.Size(),
		})
		return
	}
	writeJSON(w, map[string]any{
		"kind":      "text",
		"content":   string(body),
		"size":      fi.Size(),
		"truncated": truncated,
	})
}

// looksLikeText is a cheap text/binary heuristic: a file is text if
// its first 8KiB has no NUL bytes and decodes as valid UTF-8 (or is
// empty). NUL is the strongest binary signal in real-world files —
// images, archives, executables all contain them; source/log/markup
// files don't.
func looksLikeText(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	head := b
	if len(head) > 8192 {
		head = head[:8192]
	}
	for _, c := range head {
		if c == 0 {
			return false
		}
	}
	// Quick UTF-8 validity check on the head — utf8.Valid handles
	// the multibyte cases. We do this on the head only so a 5MiB
	// log doesn't get scanned twice.
	return validUTF8(head)
}

// validUTF8 is utf8.Valid inlined to avoid pulling unicode/utf8 into
// the import set just for this. (Already in many other files.)
func validUTF8(b []byte) bool {
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			i++
			continue
		}
		var size int
		switch {
		case c&0xE0 == 0xC0:
			size = 2
		case c&0xF0 == 0xE0:
			size = 3
		case c&0xF8 == 0xF0:
			size = 4
		default:
			return false
		}
		if i+size > len(b) {
			return false
		}
		for k := 1; k < size; k++ {
			if b[i+k]&0xC0 != 0x80 {
				return false
			}
		}
		i += size
	}
	return true
}

