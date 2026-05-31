package main

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Note is the in-memory representation of a single note. The durable source of
// truth is always the Markdown file on disk (<id>.md); this struct is what we
// read out of it and hand to the frontend.
//
// Piece 1 keeps the frontmatter deliberately small (id/title/created/updated/
// tags/status). Fields owned by later pieces (priority, coworkers, branch,
// intent, links, merge_parents) are intentionally NOT written yet so we don't
// commit to a format before its semantics exist.
type Note struct {
	ID      string    `json:"id"      yaml:"id"`
	Title   string    `json:"title"   yaml:"title"`
	Created time.Time `json:"created" yaml:"created"`
	Updated time.Time `json:"updated" yaml:"updated"`
	Tags    []string  `json:"tags"    yaml:"tags"`
	Status  string    `json:"status"  yaml:"status"`

	// Priority is one of low/medium/high (or empty = unset). Branch is the git
	// branch the note was captured on (auto-filled). People are the @mentioned
	// coworkers. All omitted from disk when empty so plain notes stay clean.
	Priority string   `json:"priority" yaml:"priority,omitempty"`
	Branch   string   `json:"branch"   yaml:"branch,omitempty"`
	People   []string `json:"people"   yaml:"people,omitempty"`

	// Anchors tie this note to concrete spots in the project's code (Level A:
	// file + line range + the git commit at anchor time). Omitted from disk when
	// empty so plain notes stay clean.
	Anchors []Anchor `json:"anchors" yaml:"anchors"`

	// Body is the Markdown content after the frontmatter block. Not part of the
	// YAML; populated/serialized separately.
	Body string `json:"body" yaml:"-"`
}

// Anchor is a "Level A" code reference: a pin to a file and line range, plus the
// git commit the project was on when the anchor was made. No content fingerprint
// yet — if the code moves we can warn (later), but we don't auto-relocate.
type Anchor struct {
	File   string `json:"file"   yaml:"file"`
	Lines  string `json:"lines"  yaml:"lines"`            // "166-195" or a single "42"
	Commit string `json:"commit" yaml:"commit,omitempty"` // short git SHA at anchor time
}

// frontmatter is the exact set of keys noteit owns and (re)writes. Keeping it a
// separate type from Note makes the on-disk contract explicit.
type frontmatter struct {
	ID       string    `yaml:"id"`
	Title    string    `yaml:"title"`
	Created  time.Time `yaml:"created"`
	Updated  time.Time `yaml:"updated"`
	Tags     []string  `yaml:"tags"`
	Status   string    `yaml:"status"`
	Priority string    `yaml:"priority,omitempty"`
	Branch   string    `yaml:"branch,omitempty"`
	People   []string  `yaml:"people,omitempty"`
	Anchors  []Anchor  `yaml:"anchors,omitempty"`
}

const fmFence = "---"

// parseNote splits a raw note file into its YAML frontmatter and Markdown body.
// A file without a leading `---` fence is treated as a bodyless/invalid note and
// returns an error so the caller can skip it with a warning.
func parseNote(raw []byte) (Note, error) {
	text := string(bytes.TrimLeft(raw, "\ufeff")) // tolerate a UTF-8 BOM

	if !strings.HasPrefix(text, fmFence) {
		return Note{}, fmt.Errorf("missing frontmatter fence")
	}

	// Drop the opening fence line, then split on the closing fence.
	rest := text[len(fmFence):]
	rest = strings.TrimLeft(rest, "\r\n")

	end := findClosingFence(rest)
	if end < 0 {
		return Note{}, fmt.Errorf("unterminated frontmatter")
	}

	yamlPart := rest[:end]
	body := rest[end:]
	body = stripClosingFence(body)

	var fm frontmatter
	if err := yaml.Unmarshal([]byte(yamlPart), &fm); err != nil {
		return Note{}, fmt.Errorf("invalid frontmatter yaml: %w", err)
	}
	if strings.TrimSpace(fm.ID) == "" {
		return Note{}, fmt.Errorf("frontmatter missing id")
	}

	return Note{
		ID:       fm.ID,
		Title:    fm.Title,
		Created:  fm.Created,
		Updated:  fm.Updated,
		Tags:     fm.Tags,
		Status:   fm.Status,
		Priority: fm.Priority,
		Branch:   fm.Branch,
		People:   fm.People,
		Anchors:  fm.Anchors,
		Body:     body,
	}, nil
}

// findClosingFence returns the byte offset (within s) of the start of the line
// that is exactly the closing `---` fence, or -1 if none is found.
func findClosingFence(s string) int {
	offset := 0
	for _, line := range splitKeepLineStarts(s) {
		if strings.TrimRight(line.text, "\r\n") == fmFence {
			return line.start
		}
		offset = line.start + len(line.text)
	}
	_ = offset
	return -1
}

// stripClosingFence removes the leading closing-fence line (and one following
// newline) so what remains is just the Markdown body.
func stripClosingFence(s string) string {
	s = strings.TrimLeft(s, "\r\n")
	if strings.HasPrefix(s, fmFence) {
		s = s[len(fmFence):]
		s = strings.TrimLeft(s, "\r\n")
	}
	return s
}

type lineSpan struct {
	start int
	text  string
}

func splitKeepLineStarts(s string) []lineSpan {
	var out []lineSpan
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, lineSpan{start: start, text: s[start : i+1]})
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, lineSpan{start: start, text: s[start:]})
	}
	return out
}

// render serializes a Note back into the canonical on-disk format: a YAML
// frontmatter block (only noteit-owned keys) followed by the Markdown body.
// noteit OWNS this format in Piece 1 — there are no hand-edited unknown keys to
// preserve yet because CreateNote is the only writer.
func (n Note) render() ([]byte, error) {
	fm := frontmatter{
		ID:       n.ID,
		Title:    n.Title,
		Created:  n.Created,
		Updated:  n.Updated,
		Tags:     n.Tags,
		Status:   n.Status,
		Priority: n.Priority,
		Branch:   n.Branch,
		People:   n.People,
		Anchors:  n.Anchors,
	}
	if fm.Tags == nil {
		fm.Tags = []string{}
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(fm); err != nil {
		return nil, err
	}
	_ = enc.Close()

	var out bytes.Buffer
	out.WriteString(fmFence + "\n")
	out.Write(buf.Bytes())
	out.WriteString(fmFence + "\n\n")
	body := strings.TrimLeft(n.Body, "\r\n")
	out.WriteString(body)
	if len(body) > 0 && !strings.HasSuffix(body, "\n") {
		out.WriteString("\n")
	}
	return out.Bytes(), nil
}
