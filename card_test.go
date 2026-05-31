package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestCardHeaderRoundTrip(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	in := Card{
		ID:      "01931b2c-0000-7000-8000-000000000001",
		Created: now,
		Updated: now,
		Author:  "gabo",
		Links:   []string{"01931b2c-0000-7000-8000-000000000002"},
		Body:    "working on the async pool\nstate := retry(ctx)",
	}
	rendered, err := renderCard(in)
	if err != nil {
		t.Fatalf("renderCard: %v", err)
	}
	lines := strings.SplitN(rendered, "\n", 2)
	got, ok := parseCardHeader(lines[0])
	if !ok {
		t.Fatalf("parseCardHeader failed for %q", lines[0])
	}
	if got.ID != in.ID || got.Author != in.Author {
		t.Errorf("id/author lost: %+v", got)
	}
	if !got.Created.Equal(in.Created) || !got.Updated.Equal(in.Updated) {
		t.Errorf("timestamps lost: created=%v updated=%v", got.Created, got.Updated)
	}
	if len(got.Links) != 1 || got.Links[0] != in.Links[0] {
		t.Errorf("links lost: %v", got.Links)
	}
}

func TestParseRenderBlocksRoundTrip(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	body := "intro prose line\n\n" +
		":::card id=01931b2c-0000-7000-8000-00000000000a created=" + now.Format(time.RFC3339) + " author=gabo\n" +
		"first status\n" +
		":::\n\n" +
		"middle prose\n\n" +
		":::card id=01931b2c-0000-7000-8000-00000000000b created=" + now.Format(time.RFC3339) + " author=ana\n" +
		"second status\n" +
		":::\n\n" +
		"trailing prose"

	blocks := parseBlocks(body)
	if len(blocks) != 5 {
		t.Fatalf("got %d blocks, want 5: %+v", len(blocks), blocks)
	}
	want := []string{"text", "card", "text", "card", "text"}
	for i, k := range want {
		if blocks[i].Kind != k {
			t.Errorf("block %d kind = %q, want %q", i, blocks[i].Kind, k)
		}
	}
	if blocks[1].Card.Body != "first status" || blocks[1].Card.Author != "gabo" {
		t.Errorf("card 1 wrong: %+v", blocks[1].Card)
	}

	// render -> parse must be stable.
	rendered, err := renderBlocks(blocks)
	if err != nil {
		t.Fatalf("renderBlocks: %v", err)
	}
	again := parseBlocks(rendered)
	if len(again) != len(blocks) {
		t.Fatalf("round-trip changed block count: %d -> %d", len(blocks), len(again))
	}
	for i := range blocks {
		if blocks[i].Kind != again[i].Kind {
			t.Errorf("round-trip block %d kind drift: %q -> %q", i, blocks[i].Kind, again[i].Kind)
		}
	}
}

func TestUnterminatedFenceKeptAsProse(t *testing.T) {
	body := "before\n\n:::card id=x\nno close fence here"
	blocks := parseBlocks(body)
	for _, b := range blocks {
		if b.Kind == "card" {
			t.Fatalf("unterminated fence should not become a card: %+v", blocks)
		}
	}
}

func TestAddCardPersistsAndJournals(t *testing.T) {
	s := newTestService(t)
	n, err := s.CreateNote("async pool", "first note line")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	doc, err := s.AddCard(n.ID, "investigating the deadlock")
	if err != nil {
		t.Fatalf("AddCard: %v", err)
	}
	cards := cardsOf(doc.Blocks)
	if len(cards) != 1 {
		t.Fatalf("got %d cards, want 1", len(cards))
	}
	if cards[0].Body != "investigating the deadlock" {
		t.Errorf("card body = %q", cards[0].Body)
	}
	if cards[0].Created.IsZero() || cards[0].Author == "" {
		t.Errorf("card not stamped: %+v", cards[0])
	}

	// Survives a reload from disk.
	reread, err := s.GetDocument(n.ID)
	if err != nil {
		t.Fatalf("GetDocument: %v", err)
	}
	if len(cardsOf(reread.Blocks)) != 1 {
		t.Fatalf("card not persisted: %+v", reread.Blocks)
	}

	// Journal recorded exactly one created event.
	evs, err := s.Timeline()
	if err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if len(evs) != 1 || evs[0].Type != EventCardCreated || evs[0].CardID != cards[0].ID {
		t.Fatalf("journal wrong: %+v", evs)
	}
}

func TestUpdateCardBumpsUpdatedAndJournals(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("x", "")
	doc, _ := s.AddCard(n.ID, "v1")
	id := cardsOf(doc.Blocks)[0].ID
	created := cardsOf(doc.Blocks)[0].Created

	time.Sleep(2 * time.Millisecond)
	doc2, err := s.UpdateCard(n.ID, id, "v2")
	if err != nil {
		t.Fatalf("UpdateCard: %v", err)
	}
	c := cardsOf(doc2.Blocks)[0]
	if c.Body != "v2" {
		t.Errorf("body not updated: %q", c.Body)
	}
	if !c.Created.Equal(created) {
		t.Errorf("created should not change: %v vs %v", c.Created, created)
	}
	if !c.Updated.After(created) {
		t.Errorf("updated should be bumped: created=%v updated=%v", created, c.Updated)
	}

	if _, err := s.UpdateCard(n.ID, "no-such-card", "x"); err == nil {
		t.Error("expected error updating missing card")
	}

	evs, _ := s.Timeline()
	if len(evs) != 2 || evs[1].Type != EventCardUpdated {
		t.Fatalf("journal should have created+updated: %+v", evs)
	}
}

func TestDeleteCardRemovesButJournalKeeps(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("x", "")
	doc, _ := s.AddCard(n.ID, "to be deleted")
	id := cardsOf(doc.Blocks)[0].ID

	doc2, err := s.DeleteCard(n.ID, id)
	if err != nil {
		t.Fatalf("DeleteCard: %v", err)
	}
	if len(cardsOf(doc2.Blocks)) != 0 {
		t.Fatalf("card not removed: %+v", doc2.Blocks)
	}

	evs, _ := s.Timeline()
	if len(evs) != 2 || evs[1].Type != EventCardDeleted {
		t.Fatalf("journal should keep delete: %+v", evs)
	}
}

func TestLinkCards(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("x", "")
	d1, _ := s.AddCard(n.ID, "card A")
	a := cardsOf(d1.Blocks)[0].ID
	d2, _ := s.AddCard(n.ID, "card B")
	b := cardsOf(d2.Blocks)[1].ID

	doc, err := s.LinkCards(n.ID, b, a)
	if err != nil {
		t.Fatalf("LinkCards: %v", err)
	}
	var fromB *Card
	for i := range doc.Blocks {
		if doc.Blocks[i].Kind == "card" && doc.Blocks[i].Card.ID == b {
			fromB = doc.Blocks[i].Card
		}
	}
	if fromB == nil || len(fromB.Links) != 1 || fromB.Links[0] != a {
		t.Fatalf("link not persisted on source card: %+v", fromB)
	}

	// Idempotent: linking again does not duplicate the edge or re-journal.
	doc, _ = s.LinkCards(n.ID, b, a)
	for i := range doc.Blocks {
		if doc.Blocks[i].Kind == "card" && doc.Blocks[i].Card.ID == b {
			if len(doc.Blocks[i].Card.Links) != 1 {
				t.Errorf("duplicate edge created: %+v", doc.Blocks[i].Card.Links)
			}
		}
	}

	if _, err := s.LinkCards(n.ID, a, a); err == nil {
		t.Error("expected error linking card to itself")
	}
	if _, err := s.LinkCards(n.ID, a, "missing"); err == nil {
		t.Error("expected error linking to missing target")
	}

	evs, _ := s.Timeline()
	// created A, created B, linked (one only; the duplicate link is not journaled).
	linked := 0
	for _, e := range evs {
		if e.Type == EventCardLinked {
			linked++
		}
	}
	if linked != 1 {
		t.Fatalf("expected exactly 1 link event, got %d: %+v", linked, evs)
	}
}

func TestCardFenceInBodyRejected(t *testing.T) {
	s := newTestService(t)
	n, _ := s.CreateNote("x", "")
	if _, err := s.AddCard(n.ID, "line1\n:::\nline2"); err == nil {
		t.Error("expected error for lone ::: in card body")
	}
}

func TestAuthorWithSpacesRoundTrips(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	in := Card{
		ID:      "01931b2c-0000-7000-8000-000000000099",
		Created: now,
		Author:  "Gabriel Sequera",
		Body:    "status",
	}
	rendered, err := renderCard(in)
	if err != nil {
		t.Fatalf("renderCard: %v", err)
	}
	header := strings.SplitN(rendered, "\n", 2)[0]
	got, ok := parseCardHeader(header)
	if !ok {
		t.Fatalf("parseCardHeader failed: %q", header)
	}
	if got.Author != "Gabriel Sequera" {
		t.Errorf("author with space lost: %q (header was %q)", got.Author, header)
	}
}

func TestNonUUIDFenceTreatedAsProse(t *testing.T) {
	body := ":::card id=not-a-uuid author=x\nfake card\n:::"
	for _, b := range parseBlocks(body) {
		if b.Kind == "card" {
			t.Fatalf("non-UUID id must not become a card: %+v", b.Card)
		}
	}
}

func TestJournalCorruptMiddleIsReported(t *testing.T) {
	s := newTestService(t)
	good1 := `{"ts":"2026-05-31T10:00:00Z","type":"card.created","noteID":"n","cardID":"c1"}`
	bad := `{not json`
	good2 := `{"ts":"2026-05-31T10:00:01Z","type":"card.created","noteID":"n","cardID":"c2"}`
	if err := os.WriteFile(s.journalPath(), []byte(good1+"\n"+bad+"\n"+good2+"\n"), 0o644); err != nil {
		t.Fatalf("seed journal: %v", err)
	}
	if _, err := s.Timeline(); err == nil {
		t.Fatal("expected corruption error for malformed middle line")
	}
}

func TestJournalTornFinalLineTolerated(t *testing.T) {
	s := newTestService(t)
	good := `{"ts":"2026-05-31T10:00:00Z","type":"card.created","noteID":"n","cardID":"c1"}`
	torn := `{"ts":"2026-05-31T10:00:01Z","ty`
	if err := os.WriteFile(s.journalPath(), []byte(good+"\n"+torn+"\n"), 0o644); err != nil {
		t.Fatalf("seed journal: %v", err)
	}
	evs, err := s.Timeline()
	if err != nil {
		t.Fatalf("torn final line should be tolerated: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1 (torn tail dropped)", len(evs))
	}
}

// cardsOf extracts cards from a block list in order, for assertions.
func cardsOf(blocks []Block) []Card {
	var out []Card
	for _, b := range blocks {
		if b.Kind == "card" && b.Card != nil {
			out = append(out, *b.Card)
		}
	}
	return out
}
