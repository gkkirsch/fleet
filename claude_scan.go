package main

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ClaudeDirView is what the UI sees for one agent's CLAUDE_CONFIG_DIR.
// Source records which agent (if any) actually owns the dir — so the UI
// can show "inherited from <orch>" or "global" where appropriate.
type ClaudeDirView struct {
	Source     string     `json:"source"` // "own" | "inherited" | "global"
	SourceID   string     `json:"source_id,omitempty"`
	Dir        string     `json:"dir"`
	Skills     []Skill    `json:"skills"`
	Agents     []NamedMD  `json:"agents"`
	Commands   []NamedMD  `json:"commands"`
	Memory     *MemoryDoc `json:"memory,omitempty"`
}

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Dir         string `json:"dir"`
	Enabled     bool   `json:"enabled"`
}

type NamedMD struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type MemoryDoc struct {
	Bytes   int64  `json:"bytes"`
	Preview string `json:"preview,omitempty"`
}

// effectiveClaudeDir mirrors roster's claudeDirFor: orchestrators own a
// dir under <XDG data>/roster/claude/<id>, workers inherit from their
// nearest orchestrator ancestor, dispatchers fall back to ~/.claude.
func effectiveClaudeDir(a Agent, all []Agent) (dir, source, sourceID string) {
	switch a.Kind {
	case "orchestrator":
		return orchClaudeDir(a.ID), "own", a.ID
	case "worker":
		orch := findOrchAncestor(a.Parent, all)
		if orch != "" {
			return orchClaudeDir(orch), "inherited", orch
		}
	}
	return globalClaudeDir(), "global", ""
}

func orchClaudeDir(id string) string {
	if d := os.Getenv("ROSTER_DIR"); d != "" {
		// ROSTER_DIR points at the agents dir itself; its parent holds
		// claude/. Walk up once.
		return filepath.Join(filepath.Dir(d), "claude", id)
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "roster", "claude", id)
}

func globalClaudeDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func findOrchAncestor(startID string, all []Agent) string {
	byID := make(map[string]Agent, len(all))
	for _, a := range all {
		byID[a.ID] = a
	}
	cur := startID
	for i := 0; i < 20 && cur != ""; i++ {
		a, ok := byID[cur]
		if !ok {
			return ""
		}
		if a.Kind == "orchestrator" {
			return a.ID
		}
		cur = a.Parent
	}
	return ""
}

// --- scanning --------------------------------------------------------------

func scanClaudeDir(dir string) (skills []Skill, agents, commands []NamedMD, memory *MemoryDoc) {
	skills = scanSkills(filepath.Join(dir, "skills"))
	agents = scanMDFolder(filepath.Join(dir, "agents"))
	commands = scanMDFolder(filepath.Join(dir, "commands"))
	memory = readMemory(filepath.Join(dir, "CLAUDE.md"))
	return
}

// scanSkills looks for skill directories, each containing SKILL.md (or
// SKILL.md.disabled). Returns them sorted by name.
func scanSkills(skillsDir string) []Skill {
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return nil
	}
	var out []Skill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		d := filepath.Join(skillsDir, e.Name())
		active := filepath.Join(d, "SKILL.md")
		disabled := filepath.Join(d, "SKILL.md.disabled")
		md := ""
		enabled := false
		if _, err := os.Stat(active); err == nil {
			md, enabled = active, true
		} else if _, err := os.Stat(disabled); err == nil {
			md = disabled
		} else {
			continue
		}
		fm := parseFrontmatter(md)
		name := fm["name"]
		if name == "" {
			name = e.Name()
		}
		out = append(out, Skill{
			Name:        name,
			Description: fm["description"],
			Dir:         d,
			Enabled:     enabled,
		})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// scanMDFolder lists *.md files in dir, pulling an optional description
// from YAML frontmatter.
func scanMDFolder(dir string) []NamedMD {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []NamedMD
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		fm := parseFrontmatter(p)
		name := strings.TrimSuffix(e.Name(), ".md")
		out = append(out, NamedMD{Name: name, Description: fm["description"]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func readMemory(path string) *MemoryDoc {
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return &MemoryDoc{Bytes: fi.Size()}
	}
	preview := strings.TrimSpace(string(b))
	if len(preview) > 240 {
		preview = preview[:240] + "…"
	}
	return &MemoryDoc{Bytes: fi.Size(), Preview: preview}
}

// parseFrontmatter reads the leading `---\n...\n---` block from a file
// and returns its keys as a flat map. Handles quoted scalars and YAML
// folded/literal block scalars (key: >, key: |): subsequent indented
// lines are joined with spaces. Anything fancier collapses to "".
func parseFrontmatter(path string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	s := string(b)
	if !strings.HasPrefix(s, "---\n") {
		return out
	}
	end := strings.Index(s[4:], "\n---")
	if end < 0 {
		return out
	}
	lines := strings.Split(s[4:4+end], "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		colon := strings.Index(line, ":")
		if colon < 0 || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		k := strings.TrimSpace(line[:colon])
		v := strings.TrimSpace(line[colon+1:])
		// Block scalar: gather following indented lines.
		if v == ">" || v == "|" || v == ">-" || v == "|-" {
			var parts []string
			for j := i + 1; j < len(lines); j++ {
				next := lines[j]
				if next == "" || strings.HasPrefix(next, " ") || strings.HasPrefix(next, "\t") {
					parts = append(parts, strings.TrimSpace(next))
					i = j
					continue
				}
				break
			}
			out[k] = strings.TrimSpace(strings.Join(parts, " "))
			continue
		}
		if (strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`)) ||
			(strings.HasPrefix(v, `'`) && strings.HasSuffix(v, `'`)) {
			v = v[1 : len(v)-1]
		}
		out[k] = v
	}
	return out
}

// --- handler ---------------------------------------------------------------

func handleClaude(w http.ResponseWriter, r *http.Request, id string) {
	all, err := loadAllAgents()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var a *Agent
	for i := range all {
		if all[i].ID == id {
			a = &all[i]
			break
		}
	}
	if a == nil {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	dir, source, sourceID := effectiveClaudeDir(*a, all)
	skills, agents, commands, memory := scanClaudeDir(dir)
	writeJSON(w, ClaudeDirView{
		Source:   source,
		SourceID: sourceID,
		Dir:      dir,
		Skills:   skills,
		Agents:   agents,
		Commands: commands,
		Memory:   memory,
	})
}
