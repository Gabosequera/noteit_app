package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Gabosequera/noteit_app/internal/vault"
	"github.com/google/uuid"
)

// NoteService is the Wails-bound backend for Piece 1: per-project note storage.
// Notes are plain Markdown files in <project>/.noteit/notes/<id>.md. These files
// are the durable source of truth; nothing else here is a cache yet.
type NoteService struct {
	mu      sync.Mutex
	root    string // resolved project root (dir that contains .noteit/)
	rootErr error  // if project root could not be safely resolved
}

// NewNoteService resolves the project root ONCE and ensures the vault exists.
// Resolution order: $NOTEIT_PROJECT -> nearest ancestor with .git -> $CWD.
// We refuse to operate on "/" or the user's home dir to avoid scattering a
// .noteit/ in a meaningless location.
func NewNoteService() *NoteService {
	s := &NoteService{}
	root, err := vault.Discover()
	if err != nil {
		s.rootErr = err
		log.Printf("noteit: project root unresolved: %v", err)
		return s
	}
	s.root = root
	if err := s.ensureVault(); err != nil {
		s.rootErr = err
		log.Printf("noteit: ensureVault failed: %v", err)
		return s
	}
	log.Printf("noteit: vault ready at %s", s.notesDir())
	return s
}

func (s *NoteService) noteitDir() string { return filepath.Join(s.root, ".noteit") }
func (s *NoteService) notesDir() string  { return filepath.Join(s.noteitDir(), "notes") }

// ensureVault creates .noteit/notes/ and writes .noteit/.gitignore = "*" so
// notes are private-by-default without touching the project's root .gitignore.
func (s *NoteService) ensureVault() error {
	if err := os.MkdirAll(s.notesDir(), 0o755); err != nil {
		return fmt.Errorf("mkdir notes: %w", err)
	}
	gitignore := filepath.Join(s.noteitDir(), ".gitignore")
	if _, err := os.Stat(gitignore); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(gitignore, []byte("*\n"), 0o644); err != nil {
			return fmt.Errorf("write .gitignore: %w", err)
		}
	}
	return nil
}

// ProjectRoot reports the resolved project root (for the UI to display), or the
// resolution error message.
func (s *NoteService) ProjectRoot() string {
	if s.rootErr != nil {
		return ""
	}
	return s.root
}

// CreateNote writes a new note to disk and returns it. title's first line is the
// title; the rest of `title` plus `body` is irrelevant here — the frontend sends
// a clean title + body. The note id is a server-generated UUIDv7; the frontend
// never controls the filename.
func (s *NoteService) CreateNote(title, body string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Note{}, s.rootErr
	}

	id, err := uuid.NewV7()
	if err != nil {
		return Note{}, fmt.Errorf("generate id: %w", err)
	}
	now := time.Now().UTC()

	title = strings.TrimSpace(title)
	if title == "" {
		title = "untitled"
	}

	n := Note{
		ID:      id.String(),
		Title:   title,
		Created: now,
		Updated: now,
		Tags:    []string{},
		Status:  "todo",
		Body:    body,
	}

	data, err := n.render()
	if err != nil {
		return Note{}, fmt.Errorf("render note: %w", err)
	}
	if err := s.writeAtomic(n.ID, data); err != nil {
		return Note{}, err
	}
	return n, nil
}

// writeAtomic writes to a temp file in the notes dir then renames into place, so
// a reader never sees a half-written note. id is validated to be a clean UUID so
// it can never escape notesDir.
func (s *NoteService) writeAtomic(id string, data []byte) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("refusing to write note with invalid id %q: %w", id, err)
	}
	dir := s.notesDir()
	tmp, err := os.CreateTemp(dir, ".tmp-*.md")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op if rename succeeded

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	final := filepath.Join(dir, id+".md")
	if err := os.Rename(tmpName, final); err != nil {
		return fmt.Errorf("rename note into place: %w", err)
	}
	return nil
}

// ListNotes reads and parses every note file, newest-first by Created. Malformed
// files are skipped with a logged warning rather than failing the whole list.
func (s *NoteService) ListNotes() ([]Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return nil, s.rootErr
	}

	entries, err := os.ReadDir(s.notesDir())
	if err != nil {
		return nil, fmt.Errorf("read notes dir: %w", err)
	}

	notes := make([]Note, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.notesDir(), e.Name()))
		if err != nil {
			log.Printf("noteit: skip %s: %v", e.Name(), err)
			continue
		}
		n, err := parseNote(raw)
		if err != nil {
			log.Printf("noteit: skip malformed %s: %v", e.Name(), err)
			continue
		}
		notes = append(notes, n)
	}

	sort.SliceStable(notes, func(i, j int) bool {
		return notes[i].Created.After(notes[j].Created)
	})
	return notes, nil
}

// GetNote returns a single note by id, including its body.
func (s *NoteService) GetNote(id string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Note{}, s.rootErr
	}
	if _, err := uuid.Parse(id); err != nil {
		return Note{}, fmt.Errorf("invalid id: %w", err)
	}
	raw, err := os.ReadFile(filepath.Join(s.notesDir(), id+".md"))
	if err != nil {
		return Note{}, fmt.Errorf("read note: %w", err)
	}
	return parseNote(raw)
}

// SaveBody overwrites a note's entire Markdown body with `body` and rewrites it
// to disk, bumping Updated. This is the Obsidian-style raw-text save path: the
// editor owns the whole document as plain text, so it simply replaces the
// "present" body. The note's frontmatter (title, tags, status, anchors, …) is
// preserved by re-rendering the parsed note with only Body/Updated changed. The
// id is validated and the write is atomic.
func (s *NoteService) SaveBody(noteID, body string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Note{}, s.rootErr
	}
	if _, err := uuid.Parse(noteID); err != nil {
		return Note{}, fmt.Errorf("invalid id: %w", err)
	}

	raw, err := os.ReadFile(filepath.Join(s.notesDir(), noteID+".md"))
	if err != nil {
		return Note{}, fmt.Errorf("read note: %w", err)
	}
	n, err := parseNote(raw)
	if err != nil {
		return Note{}, err
	}

	n.Body = body
	n.Updated = time.Now().UTC()

	data, err := n.render()
	if err != nil {
		return Note{}, fmt.Errorf("render note: %w", err)
	}
	if err := s.writeAtomic(n.ID, data); err != nil {
		return Note{}, err
	}
	return n, nil
}

// AddAnchor attaches a code reference (file + line range) to an existing note and
// rewrites it to disk. This is the "Level A" pin: we also stamp the project's
// current git commit so the anchor records the exact state it pointed at. The
// note id is validated and the file rewrite is atomic.
func (s *NoteService) AddAnchor(noteID, file, lines string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Note{}, s.rootErr
	}
	if _, err := uuid.Parse(noteID); err != nil {
		return Note{}, fmt.Errorf("invalid id: %w", err)
	}

	file = strings.TrimSpace(file)
	if file == "" {
		return Note{}, errors.New("anchor needs a file path")
	}
	lines = strings.TrimSpace(lines)
	if err := validateLineRange(lines); err != nil {
		return Note{}, err
	}

	raw, err := os.ReadFile(filepath.Join(s.notesDir(), noteID+".md"))
	if err != nil {
		return Note{}, fmt.Errorf("read note: %w", err)
	}
	n, err := parseNote(raw)
	if err != nil {
		return Note{}, err
	}

	n.Anchors = append(n.Anchors, Anchor{
		File:   filepath.ToSlash(filepath.Clean(file)),
		Lines:  lines,
		Commit: s.currentCommit(),
	})
	n.Updated = time.Now().UTC()

	data, err := n.render()
	if err != nil {
		return Note{}, fmt.Errorf("render note: %w", err)
	}
	if err := s.writeAtomic(n.ID, data); err != nil {
		return Note{}, err
	}
	return n, nil
}

// NewNote is the structured input for CreateNoteFull — the result of the
// frontend parsing a `:*` statement. Status/priority arrive already normalized
// to their canonical forms; the backend re-validates as a safety net and fills
// the git branch itself.
type NewNote struct {
	Title    string   `json:"title"`
	Body     string   `json:"body"`
	Tags     []string `json:"tags"`
	Status   string   `json:"status"`
	Priority string   `json:"priority"`
	People   []string `json:"people"`
	Anchors  []Anchor `json:"anchors"`
}

var (
	validStatus   = map[string]bool{"todo": true, "working": true, "blocked": true, "done": true}
	validPriority = map[string]bool{"low": true, "medium": true, "high": true}
)

// CreateNoteFull writes a note assembled from a parsed `:*` statement: title,
// body, tags, status, priority, people and code anchors in one shot. The git
// branch is auto-filled from the project. Unknown status/priority values are
// rejected rather than silently stored.
func (s *NoteService) CreateNoteFull(in NewNote) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Note{}, s.rootErr
	}

	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "todo"
	}
	if !validStatus[status] {
		return Note{}, fmt.Errorf("unknown status %q", status)
	}
	priority := strings.TrimSpace(in.Priority)
	if priority != "" && !validPriority[priority] {
		return Note{}, fmt.Errorf("unknown priority %q", priority)
	}

	for _, a := range in.Anchors {
		if strings.TrimSpace(a.File) == "" {
			return Note{}, errors.New("anchor needs a file path")
		}
		if err := validateLineRange(a.Lines); err != nil {
			return Note{}, err
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return Note{}, fmt.Errorf("generate id: %w", err)
	}
	now := time.Now().UTC()

	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "untitled"
	}

	commit := s.currentCommit()
	anchors := make([]Anchor, 0, len(in.Anchors))
	for _, a := range in.Anchors {
		anchors = append(anchors, Anchor{
			File:   filepath.ToSlash(filepath.Clean(a.File)),
			Lines:  strings.TrimSpace(a.Lines),
			Commit: commit,
		})
	}

	n := Note{
		ID:       id.String(),
		Title:    title,
		Created:  now,
		Updated:  now,
		Tags:     normalizeList(in.Tags),
		Status:   status,
		Priority: priority,
		Branch:   s.currentBranch(),
		People:   normalizeList(in.People),
		Anchors:  anchors,
		Body:     in.Body,
	}

	data, err := n.render()
	if err != nil {
		return Note{}, fmt.Errorf("render note: %w", err)
	}
	if err := s.writeAtomic(n.ID, data); err != nil {
		return Note{}, err
	}
	return n, nil
}

// normalizeList trims, drops empties and de-dupes while preserving order.
func normalizeList(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// currentBranch returns the project's current git branch, or "" if not a repo
// or in a detached HEAD.
func (s *NoteService) currentBranch() string {
	cmd := exec.Command("git", "-C", s.root, "branch", "--show-current")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// validateLineRange accepts a single line ("42") or an inclusive range
// ("166-195"). Bounds must be positive and start <= end.
func validateLineRange(s string) error {
	if s == "" {
		return errors.New("anchor needs a line or range, e.g. 166-195")
	}
	lo, hi, found := strings.Cut(s, "-")
	start, err := strconv.Atoi(strings.TrimSpace(lo))
	if err != nil || start < 1 {
		return fmt.Errorf("invalid line %q (want N or N-M)", s)
	}
	if found {
		end, err := strconv.Atoi(strings.TrimSpace(hi))
		if err != nil || end < start {
			return fmt.Errorf("invalid range %q (want N-M with N<=M)", s)
		}
	}
	return nil
}

// currentCommit returns the project's short git HEAD, or "" if the project is
// not a git repo (anchors still work, they just won't record a commit).
func (s *NoteService) currentCommit() string {
	cmd := exec.Command("git", "-C", s.root, "rev-parse", "--short", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ───────────────────────────── cmdline file finder ─────────────────────────────

// DirEntry is one item in the cmdline file finder.
type DirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

// ListDir powers the per-directory file finder (option A: instant, no index).
// `input` is the path the user is typing in the cmdline. We resolve the path
// notation for its DIRECTORY part and list that one directory, filtering by the
// trailing partial segment. Notation:
//
//	~ , ~/x   → user home
//	./x , /x  → project root (a lone `/` means root, NOT the filesystem root)
//	x         → project root + /x
//
// Returns at most 60 entries, directories first then prefix-matches. Never errors
// on a missing/unreadable directory (returns empty) so the live finder degrades
// quietly while you type a path that doesn't exist yet.
func (s *NoteService) ListDir(input string) ([]DirEntry, error) {
	dirInput, partial := splitDirPartial(input)
	base, err := s.resolveBase(dirInput)
	if err != nil {
		return []DirEntry{}, nil
	}
	des, err := os.ReadDir(base)
	if err != nil {
		return []DirEntry{}, nil
	}

	needle := strings.ToLower(partial)
	type scored struct {
		e    DirEntry
		pref bool // name starts with the needle (ranked above plain substring hits)
	}
	hits := make([]scored, 0, len(des))
	for _, de := range des {
		name := de.Name()
		low := strings.ToLower(name)
		if needle != "" && !strings.Contains(low, needle) {
			continue
		}
		hits = append(hits, scored{
			e:    DirEntry{Name: name, IsDir: de.IsDir()},
			pref: needle != "" && strings.HasPrefix(low, needle),
		})
	}
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if a.e.IsDir != b.e.IsDir {
			return a.e.IsDir // directories first
		}
		if a.pref != b.pref {
			return a.pref // prefix matches before substring matches
		}
		return strings.ToLower(a.e.Name) < strings.ToLower(b.e.Name)
	})
	if len(hits) > 60 {
		hits = hits[:60]
	}
	out := make([]DirEntry, len(hits))
	for i, h := range hits {
		out[i] = h.e
	}
	return out, nil
}

// splitDirPartial cuts `input` at its last slash into the directory portion and
// the trailing partial segment being typed. "src/po" → ("src","po"); "po" → ("","po").
func splitDirPartial(input string) (dir, partial string) {
	i := strings.LastIndex(input, "/")
	if i < 0 {
		return "", input
	}
	return input[:i], input[i+1:]
}

// resolveBase maps the directory notation to a real absolute path. A lone `/` (or
// "" or ".") resolves to the project root by design — the user almost never wants
// the filesystem root, so `/` is treated as `./`.
func (s *NoteService) resolveBase(dirInput string) (string, error) {
	if s.root == "" {
		return "", errors.New("no project root")
	}
	home, _ := os.UserHomeDir()
	switch {
	case dirInput == "" || dirInput == "/" || dirInput == ".":
		return s.root, nil
	case dirInput == "~":
		if home == "" {
			return "", errors.New("no home dir")
		}
		return home, nil
	case strings.HasPrefix(dirInput, "~/"):
		if home == "" {
			return "", errors.New("no home dir")
		}
		return filepath.Join(home, dirInput[2:]), nil
	case strings.HasPrefix(dirInput, "./"):
		return filepath.Join(s.root, dirInput[2:]), nil
	case strings.HasPrefix(dirInput, "/"):
		return filepath.Join(s.root, dirInput[1:]), nil
	default:
		return filepath.Join(s.root, dirInput), nil
	}
}
