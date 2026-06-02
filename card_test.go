package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func mustV7(t *testing.T) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("uuid: %v", err)
	}
	return id.String()
}

func sampleCard(t *testing.T, body string) Card {
	t.Helper()
	return Card{
		ID:      mustV7(t),
		Created: time.Now().UTC().Round(0),
		Body:    body,
		Tags:    Tags{Type: "feat", Status: "doing"},
	}
}

// ───────────────────────── framing: serialize/parse ─────────────────────────

func TestSerializeParseRoundTrip(t *testing.T) {
	bodies := []string{
		"simple body",
		"multi\nline\nbody",
		"body with --- a line\nand a > blockquote",
		"a line that looks like a header:\n> CARD | id:x | created:y | type:z | status:w | bytes:3",
		"a line that looks like a footer:\n> ENDCARD deadbeef",
		"trailing newline kept\n",
		"unicode: café — niño ✅",
	}
	for _, body := range bodies {
		c := sampleCard(t, body)
		c.Tags.Area = []string{"client", "backend"}
		c.Tags.Priority = "p1"
		blk := c.serialize()
		got, next, err := parseBlock(blk, 0)
		if err != nil {
			t.Fatalf("parseBlock(%q): %v", body, err)
		}
		if next != len(blk) {
			t.Errorf("next=%d want %d", next, len(blk))
		}
		if got.Body != body {
			t.Errorf("body round-trip:\n got %q\nwant %q", got.Body, body)
		}
		if got.ID != c.ID || got.Tags.Type != "feat" || got.Tags.Status != "doing" {
			t.Errorf("header round-trip mismatch: %+v", got)
		}
		if len(got.Tags.Area) != 2 || got.Tags.Area[0] != "client" {
			t.Errorf("area round-trip: %v", got.Tags.Area)
		}
	}
}

func TestParseRefRoundTrip(t *testing.T) {
	target := mustV7(t)
	c := sampleCard(t, "child")
	c.Ref = &Ref{ID: target, Kind: RefParent}
	got, _, err := parseBlock(c.serialize(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref == nil || got.Ref.ID != target || got.Ref.Kind != RefParent {
		t.Fatalf("ref round-trip: %+v", got.Ref)
	}

	c.Ref = &Ref{ID: target, Kind: RefLink}
	got, _, err = parseBlock(c.serialize(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref == nil || got.Ref.Kind != RefLink {
		t.Fatalf("link ref round-trip: %+v", got.Ref)
	}
}

func TestAreaEncodingSurvivesDelimiters(t *testing.T) {
	c := sampleCard(t, "x")
	c.Tags.Area = []string{"weird, area | value\nbreak"}
	blk := c.serialize()
	// The header is the first line; it must remain single-line and unbroken.
	header := string(blk[:strings.IndexByte(string(blk), '\n')])
	if strings.Count(header, "|") != strings.Count(header, " | ") {
		// every | must be a real separator, none from the area value
		t.Errorf("area value leaked a raw pipe into header: %q", header)
	}
	got, _, err := parseBlock(blk, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags.Area) != 1 || got.Tags.Area[0] != "weird, area | value\nbreak" {
		t.Fatalf("area decode: %q", got.Tags.Area)
	}
}

// ───────────────────────── torn tail vs corruption ──────────────────────────

func TestParseBlockTornTail(t *testing.T) {
	c := sampleCard(t, "hello world")
	full := c.serialize()
	// Every strict prefix shorter than the whole block is a torn tail.
	for cut := 1; cut < len(full); cut++ {
		_, _, err := parseBlock(full[:cut], 0)
		if err == nil {
			t.Errorf("cut=%d parsed a partial block as complete", cut)
			continue
		}
		if err != errTornTail {
			// A cut that lands right after a complete, valid header line but with
			// truncated body must still read as torn, never corrupt.
			t.Errorf("cut=%d: got %v, want errTornTail", cut, err)
		}
	}
}

func TestParseBlockCorruptFooter(t *testing.T) {
	c := sampleCard(t, "hello")
	blk := c.serialize()
	// Corrupt the footer id but keep the trailing newline → complete but wrong.
	bad := strings.Replace(string(blk), "> ENDCARD "+c.ID, "> ENDCARD wrongid", 1)
	_, _, err := parseBlock([]byte(bad), 0)
	if err == nil || err == errTornTail {
		t.Fatalf("corrupt footer: got %v, want a corruption error", err)
	}
}

func TestParseBlockUnknownKeyIsCorrupt(t *testing.T) {
	line := "> CARD | id:" + mustV7(t) + " | created:" + time.Now().UTC().Format(time.RFC3339Nano) +
		" | type:note | status:todo | bogus:1 | bytes:1\nx\n> ENDCARD x\n"
	_, _, err := parseBlock([]byte(line), 0)
	if err == nil || err == errTornTail {
		t.Fatalf("unknown key: got %v, want corruption error", err)
	}
}

// ───────────────────────────── store integration ────────────────────────────

func newCardTestService(t *testing.T) *CardService {
	t.Helper()
	dir := t.TempDir()
	s := &CardService{
		root:  dir,
		path:  filepath.Join(dir, ".noteit", "timeline.md"),
		index: map[string]int{},
	}
	if err := s.ensureVault(); err != nil {
		t.Fatalf("ensureVault: %v", err)
	}
	if err := s.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	return s
}

func TestCreateAndReload(t *testing.T) {
	s := newCardTestService(t)
	a, err := s.CreateCard(NewCard{Tags: []string{"feat", "doing", "client"}, Body: "first"})
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "second", RefID: a.ID, RefKind: RefParent})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	// Reload from disk into a fresh service: same two cards, in order.
	s2 := &CardService{root: s.root, path: s.path, index: map[string]int{}}
	if err := s2.load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	list, err := s2.ListCards(CardFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != a.ID || list[1].ID != b.ID {
		t.Fatalf("reloaded order wrong: %d cards", len(list))
	}

	// Derived children: a has b as a parent-child.
	got, err := s2.GetCard(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Children) != 1 || got.Children[0] != b.ID {
		t.Fatalf("children derive: %v", got.Children)
	}
	if got.Tags.Horizon != "now" {
		t.Errorf("horizon default not applied: %q", got.Tags.Horizon)
	}
}

func TestReloadTruncatesTornTail(t *testing.T) {
	s := newCardTestService(t)
	a, _ := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "keep me"})
	if _, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "lose me"}); err != nil {
		t.Fatal(err)
	}

	// Simulate a torn append: chop the last few bytes of the file.
	data, _ := os.ReadFile(s.path)
	if err := os.WriteFile(s.path, data[:len(data)-4], 0o644); err != nil {
		t.Fatal(err)
	}

	s2 := &CardService{root: s.root, path: s.path, index: map[string]int{}}
	if err := s2.load(); err != nil {
		t.Fatalf("load after tear: %v", err)
	}
	list, _ := s2.ListCards(CardFilter{})
	if len(list) != 1 || list[0].ID != a.ID {
		t.Fatalf("torn tail not truncated: %d cards", len(list))
	}
	// The file must have been physically truncated so the next append is clean.
	c, err := s2.CreateCard(NewCard{Tags: []string{"docs"}, Body: "after recovery"})
	if err != nil {
		t.Fatalf("append after recovery: %v", err)
	}
	s3 := &CardService{root: s.root, path: s.path, index: map[string]int{}}
	if err := s3.load(); err != nil {
		t.Fatalf("final load: %v", err)
	}
	list, _ = s3.ListCards(CardFilter{})
	if len(list) != 2 || list[1].ID != c.ID {
		t.Fatalf("post-recovery state wrong: %d cards", len(list))
	}
}

func TestMidFileCorruptionBlocksWrites(t *testing.T) {
	s := newCardTestService(t)
	if _, err := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "two"}); err != nil {
		t.Fatal(err)
	}
	// Corrupt the FIRST block's footer (not the tail) → mid-file corruption.
	data, _ := os.ReadFile(s.path)
	corrupt := strings.Replace(string(data), "> ENDCARD ", "> ENDCARX ", 1)
	os.WriteFile(s.path, []byte(corrupt), 0o644)

	s2 := &CardService{root: s.root, path: s.path, index: map[string]int{}}
	err := s2.load()
	if err == nil {
		t.Fatal("expected corruption error on load")
	}
	s2.corrupt = err
	if _, err := s2.CreateCard(NewCard{Tags: []string{"docs"}, Body: "blocked"}); err == nil {
		t.Fatal("expected write to be refused on corrupt timeline")
	}
}

// ─────────────────────────────── tag resolver ───────────────────────────────

func TestResolveTagsBasics(t *testing.T) {
	tg, err := resolveTags([]string{"feature", "WIP", "high", "frontend", "next"})
	if err != nil {
		t.Fatal(err)
	}
	if tg.Type != "feat" || tg.Status != "doing" || tg.Priority != "p1" || tg.Horizon != "next" {
		t.Fatalf("resolve: %+v", tg)
	}
	if len(tg.Area) != 1 || tg.Area[0] != "client" {
		t.Fatalf("area: %v", tg.Area)
	}
}

func TestResolveTagsDefaults(t *testing.T) {
	tg, err := resolveTags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if tg.Type != "note" || tg.Status != "todo" {
		t.Fatalf("defaults: %+v", tg)
	}
	if tg.Horizon != "" {
		t.Errorf("horizon must NOT be materialized by resolver, got %q", tg.Horizon)
	}
}

func TestResolveTagsConflictIsHardError(t *testing.T) {
	if _, err := resolveTags([]string{"feat", "fix"}); err == nil {
		t.Fatal("expected conflicting type error")
	}
}

func TestResolveTagsUnknownLastIsFreeArea(t *testing.T) {
	tg, err := resolveTags([]string{"feat", "mycustomzone"})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(tg.Area) != 1 || tg.Area[0] != "mycustomzone" {
		t.Fatalf("free area: %v", tg.Area)
	}
}

func TestResolveTagsUnknownNonLastErrors(t *testing.T) {
	if _, err := resolveTags([]string{"bogusword", "feat"}); err == nil {
		t.Fatal("expected unknown non-last token error")
	}
}

func TestResolveTagsFreeAreaPreservesOriginalText(t *testing.T) {
	tg, err := resolveTags([]string{"feat", "MyClientÁrea"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.Area) != 1 || tg.Area[0] != "MyClientÁrea" {
		t.Fatalf("free area must keep original case/accents: %v", tg.Area)
	}
}

func TestResolveTagsTrailingEmptyTokenIsIgnored(t *testing.T) {
	// A trailing empty token must not steal the "last token = free area" slot.
	tg, err := resolveTags([]string{"feat", "mycustomzone", ""})
	if err != nil {
		t.Fatalf("trailing empty token broke last-token rule: %v", err)
	}
	if len(tg.Area) != 1 || tg.Area[0] != "mycustomzone" {
		t.Fatalf("free area: %v", tg.Area)
	}
}

func TestResolveTagsAccentAndCase(t *testing.T) {
	tg, err := resolveTags([]string{"Úrgente", "Háciendo"})
	if err != nil {
		t.Fatal(err)
	}
	if tg.Priority != "p0" || tg.Status != "doing" {
		t.Fatalf("accent/case fold: %+v", tg)
	}
}
