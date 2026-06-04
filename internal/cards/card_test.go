package cards

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

// TestParseBlockMalformedRefKindIsCorrupt proves a stored ref with a kind the
// writer can never emit (a typo, or an extra ":suffix") is treated as corruption
// rather than silently downgraded to a link with wrong semantics.
func TestParseBlockMalformedRefKindIsCorrupt(t *testing.T) {
	target := mustV7(t)
	for _, suffix := range []string{":", ":garbage", ":parent:extra", ":link:x"} {
		c := sampleCard(t, "child")
		blk := string(c.serialize())
		// Inject a ref header field carrying the bad kind, right before bytes.
		bad := strings.Replace(blk, " | bytes:", " | ref:"+target+suffix+" | bytes:", 1)
		_, _, err := parseBlock([]byte(bad), 0)
		if err == nil || err == errTornTail {
			t.Fatalf("ref suffix %q: got %v, want a corruption error", suffix, err)
		}
	}

	// A bare ref (no kind) and an explicit :parent must still parse cleanly.
	for _, suffix := range []string{"", ":parent", ":link"} {
		c := sampleCard(t, "child")
		blk := string(c.serialize())
		good := strings.Replace(blk, " | bytes:", " | ref:"+target+suffix+" | bytes:", 1)
		if _, _, err := parseBlock([]byte(good), 0); err != nil {
			t.Fatalf("valid ref suffix %q rejected: %v", suffix, err)
		}
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

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".noteit"), 0o755); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}
	s := New(filepath.Join(dir, ".noteit", "timeline.md"))
	if s.corrupt != nil {
		t.Fatalf("fresh store reported corruption: %v", s.corrupt)
	}
	return s
}

func TestCreateAndReload(t *testing.T) {
	s := newTestStore(t)
	a, err := s.CreateCard(NewCard{Tags: []string{"feat", "doing", "client"}, Body: "first"})
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "second", RefID: a.ID, RefKind: RefParent})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	// Reload from disk into a fresh service: same two cards, in order.
	s2 := New(s.path)
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
	s := newTestStore(t)
	a, _ := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "keep me"})
	if _, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "lose me"}); err != nil {
		t.Fatal(err)
	}

	// Simulate a torn append: chop the last few bytes of the file.
	data, _ := os.ReadFile(s.path)
	if err := os.WriteFile(s.path, data[:len(data)-4], 0o644); err != nil {
		t.Fatal(err)
	}

	s2 := New(s.path)
	list, _ := s2.ListCards(CardFilter{})
	if len(list) != 1 || list[0].ID != a.ID {
		t.Fatalf("torn tail not truncated: %d cards", len(list))
	}
	// The file must have been physically truncated so the next append is clean.
	c, err := s2.CreateCard(NewCard{Tags: []string{"docs"}, Body: "after recovery"})
	if err != nil {
		t.Fatalf("append after recovery: %v", err)
	}
	s3 := New(s.path)
	list, _ = s3.ListCards(CardFilter{})
	if len(list) != 2 || list[1].ID != c.ID {
		t.Fatalf("post-recovery state wrong: %d cards", len(list))
	}
}

func TestMidFileCorruptionBlocksWrites(t *testing.T) {
	s := newTestStore(t)
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

	s2 := New(s.path)
	if s2.corrupt == nil {
		t.Fatal("expected corruption to be detected on load")
	}
	if _, err := s2.CreateCard(NewCard{Tags: []string{"docs"}, Body: "blocked"}); err == nil {
		t.Fatal("expected write to be refused on corrupt timeline")
	}
}

// TestReloadAfterTimelineDeleted exercises reload-safety: if the timeline file is
// removed out from under a loaded Store, a reload must drop the stale in-memory
// cards (not keep serving deleted entries) and recreate a clean, appendable file.
func TestReloadAfterTimelineDeleted(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "gone soon"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(s.path); err != nil {
		t.Fatal(err)
	}
	if err := s.load(); err != nil {
		t.Fatalf("reload after delete: %v", err)
	}
	list, err := s.ListCards(CardFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("stale cards survived delete+reload: %d", len(list))
	}
	if _, err := s.CreateCard(NewCard{Tags: []string{"docs"}, Body: "fresh"}); err != nil {
		t.Fatalf("append after recreate: %v", err)
	}
}

// TestReloadRecoversFromRepairedCorruption verifies that a mid-file-corruption
// poison is not permanent: once the file is repaired, a clean reload clears
// s.corrupt and restores normal operation (and the poison preserved live state).
func TestReloadRecoversFromRepairedCorruption(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "one"})
	if _, err := s.CreateCard(NewCard{Tags: []string{"fix"}, Body: "two"}); err != nil {
		t.Fatal(err)
	}
	good, _ := os.ReadFile(s.path)

	// Corrupt mid-file, reload → poisoned, reads refused.
	corrupt := strings.Replace(string(good), "> ENDCARD ", "> ENDCARX ", 1)
	if err := os.WriteFile(s.path, []byte(corrupt), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.load(); err == nil {
		t.Fatal("expected corruption error on reload")
	}
	if s.corrupt == nil {
		t.Fatal("store not poisoned after corrupt reload")
	}
	if _, err := s.ListCards(CardFilter{}); err == nil {
		t.Fatal("expected reads to error while poisoned")
	}

	// Repair the file, reload → poison cleared, state restored.
	if err := os.WriteFile(s.path, good, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.load(); err != nil {
		t.Fatalf("reload after repair: %v", err)
	}
	if s.corrupt != nil {
		t.Fatalf("poison not cleared after good reload: %v", s.corrupt)
	}
	list, err := s.ListCards(CardFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != a.ID {
		t.Fatalf("recovered state wrong: %d cards", len(list))
	}
}

// TestListCardsRejectsUnknownFilter proves a malformed controlled filter value is
// a hard error (not a silent empty result), so an MCP/GUI caller learns it mistyped
// instead of believing the timeline is empty. A synonym must still resolve.
func TestListCardsRejectsUnknownFilter(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateCard(NewCard{Tags: []string{"feat", "done"}, Body: "x"}); err != nil {
		t.Fatal(err)
	}

	if _, err := s.ListCards(CardFilter{Status: "nonsense"}); err == nil {
		t.Fatal("expected unknown status filter to error")
	}
	// A value that resolves to the WRONG axis is also rejected.
	if _, err := s.ListCards(CardFilter{Status: "feat"}); err == nil {
		t.Fatal("expected a type value in the status filter to error")
	}
	// A synonym resolves to canonical and matches the stored card.
	list, err := s.ListCards(CardFilter{Status: "resuelto"})
	if err != nil {
		t.Fatalf("synonym filter errored: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("synonym filter did not match canonical: %d cards", len(list))
	}
	// A genuinely unknown area is kept verbatim (areas are free-text) and simply
	// matches nothing rather than erroring.
	if _, err := s.ListCards(CardFilter{Area: "some-free-area"}); err != nil {
		t.Fatalf("free-text area filter must not error: %v", err)
	}
	// But a KNOWN token of a different axis ("feat" is a type) can never be stored
	// as a free area, so filtering by it is a hard error, not a silent empty result.
	if _, err := s.ListCards(CardFilter{Area: "feat"}); err == nil {
		t.Fatal("expected a type value in the area filter to error")
	}
	// A known area synonym canonicalizes and is accepted.
	if _, err := s.ListCards(CardFilter{Area: "frontend"}); err != nil {
		t.Fatalf("area synonym filter must not error: %v", err)
	}
}

// TestCreateCardRejectsRefKindWithoutRefID proves a refKind with no refId is a hard
// error rather than being silently dropped, so a caller's relationship intent is
// never lost without feedback.
func TestCreateCardRejectsRefKindWithoutRefID(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateCard(NewCard{Tags: []string{"feat"}, Body: "x", RefKind: RefParent}); err == nil {
		t.Fatal("expected refKind without refId to error")
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
