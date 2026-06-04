package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gabosequera/noteit_app/internal/vault"
)

// newTestService builds a NoteService rooted at a temp dir, bypassing the
// CWD/.git resolution so tests are hermetic.
func newTestService(t *testing.T) *NoteService {
	t.Helper()
	root := t.TempDir()
	s := &NoteService{root: root}
	if err := s.ensureVault(); err != nil {
		t.Fatalf("ensureVault: %v", err)
	}
	return s
}

func TestCreateAndGetRoundTrip(t *testing.T) {
	s := newTestService(t)

	created, err := s.CreateNote("Refactor: async pool", "first line\n\nsecond paragraph")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected non-empty id")
	}
	if created.Status != "todo" {
		t.Errorf("default status = %q, want todo", created.Status)
	}

	got, err := s.GetNote(created.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if got.Title != "Refactor: async pool" {
		t.Errorf("title = %q", got.Title)
	}
	if !strings.Contains(got.Body, "second paragraph") {
		t.Errorf("body not preserved: %q", got.Body)
	}
	if got.Created.IsZero() {
		t.Error("created timestamp not persisted")
	}
}

func TestCreateWritesFileNamedByID(t *testing.T) {
	s := newTestService(t)
	n, err := s.CreateNote("hello", "")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	want := filepath.Join(s.notesDir(), n.ID+".md")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("expected note file %s: %v", want, err)
	}
}

func TestEmptyTitleBecomesUntitled(t *testing.T) {
	s := newTestService(t)
	n, err := s.CreateNote("   ", "body")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if n.Title != "untitled" {
		t.Errorf("title = %q, want untitled", n.Title)
	}
}

func TestListNewestFirst(t *testing.T) {
	s := newTestService(t)
	// UUIDv7 + UTC now; created order should be a, then b.
	a, _ := s.CreateNote("first", "")
	b, _ := s.CreateNote("second", "")

	notes, err := s.ListNotes()
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if len(notes) != 2 {
		t.Fatalf("got %d notes, want 2", len(notes))
	}
	// newest-first => b before a (b.Created >= a.Created)
	if notes[0].ID != b.ID && notes[1].ID != a.ID {
		t.Errorf("unexpected order: %s then %s (a=%s b=%s)", notes[0].ID, notes[1].ID, a.ID, b.ID)
	}
}

func TestListSkipsMalformed(t *testing.T) {
	s := newTestService(t)
	if _, err := s.CreateNote("good", ""); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	// Drop a malformed .md straight into the notes dir.
	bad := filepath.Join(s.notesDir(), "garbage.md")
	if err := os.WriteFile(bad, []byte("no frontmatter here"), 0o644); err != nil {
		t.Fatalf("write bad: %v", err)
	}
	// And one with a frontmatter fence but no id.
	bad2 := filepath.Join(s.notesDir(), "noid.md")
	if err := os.WriteFile(bad2, []byte("---\ntitle: x\n---\nbody"), 0o644); err != nil {
		t.Fatalf("write bad2: %v", err)
	}

	notes, err := s.ListNotes()
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if len(notes) != 1 {
		t.Fatalf("got %d notes, want 1 (malformed skipped)", len(notes))
	}
}

func TestParseRenderRoundTrip(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("Title With: colon", "## heading\n\ntext with [[link]]\n")

	raw, err := os.ReadFile(filepath.Join(s.notesDir(), n.ID+".md"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	parsed, err := parseNote(raw)
	if err != nil {
		t.Fatalf("parseNote: %v", err)
	}
	if parsed.Title != n.Title {
		t.Errorf("title round-trip: %q != %q", parsed.Title, n.Title)
	}
	if !strings.Contains(parsed.Body, "[[link]]") {
		t.Errorf("body round-trip lost content: %q", parsed.Body)
	}
}

func TestAddAnchorRoundTrip(t *testing.T) {
	s := newTestService(t)
	n, err := s.CreateNote("bug: writeAtomic", "")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	got, err := s.AddAnchor(n.ID, "noteservice.go", "166-195")
	if err != nil {
		t.Fatalf("AddAnchor: %v", err)
	}
	if len(got.Anchors) != 1 {
		t.Fatalf("got %d anchors, want 1", len(got.Anchors))
	}
	if got.Anchors[0].File != "noteservice.go" || got.Anchors[0].Lines != "166-195" {
		t.Errorf("anchor = %+v", got.Anchors[0])
	}

	// Anchor must survive a read back from disk.
	reread, err := s.GetNote(n.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if len(reread.Anchors) != 1 || reread.Anchors[0].Lines != "166-195" {
		t.Errorf("anchor not persisted: %+v", reread.Anchors)
	}
}

func TestAddAnchorRejectsBadRange(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("x", "")
	for _, bad := range []string{"", "abc", "0", "10-5", "-5", "5-"} {
		if _, err := s.AddAnchor(n.ID, "f.go", bad); err == nil {
			t.Errorf("expected error for lines %q", bad)
		}
	}
}

func TestAddAnchorRejectsBadID(t *testing.T) {
	s := newTestService(t)
	if _, err := s.AddAnchor("../../etc/passwd", "f.go", "1"); err == nil {
		t.Fatal("expected error for invalid note id")
	}
}

func TestValidateLineRange(t *testing.T) {
	ok := []string{"1", "42", "166-195", "10-10"}
	for _, s := range ok {
		if err := validateLineRange(s); err != nil {
			t.Errorf("validateLineRange(%q) = %v, want nil", s, err)
		}
	}
}

func TestCreateNoteFullPersistsAllFields(t *testing.T) {
	s := newTestService(t)
	in := NewNote{
		Title:    "Refactor del pool",
		Body:     "el flujo X falla cuando Y",
		Tags:     []string{"bug", "fix", "bug"}, // dup dropped
		Status:   "working",
		Priority: "medium",
		People:   []string{"gabriel", "ana"},
		Anchors:  []Anchor{{File: "noteservice.go", Lines: "10-20"}},
	}
	n, err := s.CreateNoteFull(in)
	if err != nil {
		t.Fatalf("CreateNoteFull: %v", err)
	}

	got, err := s.GetNote(n.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if got.Status != "working" || got.Priority != "medium" {
		t.Errorf("status/priority = %q/%q", got.Status, got.Priority)
	}
	if len(got.Tags) != 2 {
		t.Errorf("tags not de-duped: %v", got.Tags)
	}
	if len(got.People) != 2 || got.People[0] != "gabriel" {
		t.Errorf("people = %v", got.People)
	}
	if len(got.Anchors) != 1 || got.Anchors[0].Lines != "10-20" {
		t.Errorf("anchors = %+v", got.Anchors)
	}
}

func TestCreateNoteFullDefaultsAndValidation(t *testing.T) {
	s := newTestService(t)

	// Empty status defaults to todo; empty priority stays empty.
	n, err := s.CreateNoteFull(NewNote{Title: "x"})
	if err != nil {
		t.Fatalf("CreateNoteFull: %v", err)
	}
	if n.Status != "todo" || n.Priority != "" {
		t.Errorf("defaults wrong: status=%q priority=%q", n.Status, n.Priority)
	}

	if _, err := s.CreateNoteFull(NewNote{Title: "x", Status: "bogus"}); err == nil {
		t.Error("expected error for unknown status")
	}
	if _, err := s.CreateNoteFull(NewNote{Title: "x", Priority: "urgent"}); err == nil {
		t.Error("expected error for unknown priority (urgent is a frontend alias, not canonical)")
	}
	if _, err := s.CreateNoteFull(NewNote{Title: "x", Anchors: []Anchor{{File: "f.go", Lines: "bad"}}}); err == nil {
		t.Error("expected error for bad anchor range")
	}
}

func TestGetInvalidIDRejected(t *testing.T) {
	s := newTestService(t)
	if _, err := s.GetNote("../../etc/passwd"); err == nil {
		t.Fatal("expected error for path-traversal id")
	}
}

func TestListDirNotationAndFilter(t *testing.T) {
	s := newTestService(t)
	// project layout: src/pool.go, src/parser.go, cmd/, README.md
	mustMkdir(t, filepath.Join(s.root, "src"))
	mustMkdir(t, filepath.Join(s.root, "cmd"))
	mustWrite(t, filepath.Join(s.root, "src", "pool.go"), "x")
	mustWrite(t, filepath.Join(s.root, "src", "parser.go"), "x")
	mustWrite(t, filepath.Join(s.root, "README.md"), "x")

	// "/" means project root (NOT filesystem root). Dirs come first.
	root, err := s.ListDir("/")
	if err != nil {
		t.Fatalf("ListDir: %v", err)
	}
	if len(root) < 3 {
		t.Fatalf("expected at least 3 entries at root, got %d: %+v", len(root), root)
	}
	if !root[0].IsDir {
		t.Errorf("directories should sort first, got %+v", root[0])
	}

	// "./src/" lists inside src; "/src/" must be identical (/ == ./).
	a, _ := s.ListDir("./src/")
	b, _ := s.ListDir("/src/")
	if len(a) != len(b) || len(a) != 2 {
		t.Fatalf("./src/ vs /src/ mismatch: %d vs %d", len(a), len(b))
	}

	// partial segment filters: "/src/po" → only pool.go.
	hits, _ := s.ListDir("/src/po")
	if len(hits) != 1 || hits[0].Name != "pool.go" {
		t.Errorf("filter /src/po = %+v, want [pool.go]", hits)
	}

	// missing dir degrades to empty, no error.
	none, err := s.ListDir("/does/not/exist/x")
	if err != nil || len(none) != 0 {
		t.Errorf("missing dir = (%+v, %v), want ([], nil)", none, err)
	}
}

func TestResolveBaseHome(t *testing.T) {
	s := newTestService(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	got, err := s.resolveBase("~")
	if err != nil || got != home {
		t.Errorf("resolveBase(~) = (%q,%v), want %q", got, err, home)
	}
	if got, _ := s.resolveBase("/"); got != s.root {
		t.Errorf("resolveBase(/) = %q, want root %q", got, s.root)
	}
	if got, _ := s.resolveBase("./src"); got != filepath.Join(s.root, "src") {
		t.Errorf("resolveBase(./src) = %q", got)
	}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}
func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestValidateRootRejectsHomeAndSlash(t *testing.T) {
	if _, err := vault.ValidateRoot("/"); err == nil {
		t.Error("expected / to be rejected")
	}
	if home, err := os.UserHomeDir(); err == nil {
		if _, err := vault.ValidateRoot(home); err == nil {
			t.Error("expected home dir to be rejected")
		}
	}
}
