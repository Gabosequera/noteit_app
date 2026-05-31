package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ───────────────────────────── card service ─────────────────────────────
//
// These methods are the only writers of cards. Each one: (1) mutates the note
// document on disk (the present), then (2) appends an immutable journal event
// (the history). Both happen under s.mu so no two card ops interleave.
//
// ORDERING CONTRACT: the note file is written FIRST and is the source of truth
// for the present; the journal is the source of truth for history. The two
// writes are NOT a single atomic transaction across files. If the journal append
// fails after the note write succeeds, the method returns the error — the
// document is updated but that one event is missing from the timeline. We accept
// this for now (a local fsync'd append rarely fails once the note write landed)
// rather than ship a half-built outbox. A transactional rebuild — replaying the
// journal and reconciling against note files on startup — is its own later piece.
//
// The frontend gets back the whole Document so it can re-render the interleaved
// prose+cards without a second round-trip.

// Document is the note plus its parsed, ordered blocks (prose + cards). Blocks
// is a disposable projection of Note.Body; the .md file remains source of truth.
type Document struct {
	Note   Note    `json:"note"`
	Blocks []Block `json:"blocks"`
}

// GetDocument loads a note and parses its body into ordered blocks for rendering.
func (s *NoteService) GetDocument(id string) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.readNoteLocked(id)
	if err != nil {
		return Document{}, err
	}
	return Document{Note: n, Blocks: parseBlocks(n.Body)}, nil
}

// AddCard appends a new status card to the end of a note document and records a
// card.created event. The card id is a server-generated UUIDv7; created/updated
// are stamped now (UTC). Returns the updated Document.
func (s *NoteService) AddCard(noteID, body string) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	n, err := s.readNoteLocked(noteID)
	if err != nil {
		return Document{}, err
	}
	if hasLoneFence(body) {
		return Document{}, errCardFenceInBody
	}

	cid, err := uuid.NewV7()
	if err != nil {
		return Document{}, fmt.Errorf("generate card id: %w", err)
	}
	now := time.Now().UTC()
	author := s.currentAuthor()

	card := Card{
		ID:      cid.String(),
		Created: now,
		Updated: now,
		Author:  author,
		Body:    strings.Trim(body, "\n"),
	}

	blocks := parseBlocks(n.Body)
	c := card
	blocks = append(blocks, Block{Kind: "card", Card: &c})

	if err := s.saveBlocksLocked(&n, blocks, now); err != nil {
		return Document{}, err
	}
	if err := s.appendEvent(JournalEvent{
		TS: now, Type: EventCardCreated, NoteID: n.ID, CardID: card.ID, Author: author,
	}); err != nil {
		return Document{}, err
	}
	return Document{Note: n, Blocks: blocks}, nil
}

// UpdateCard replaces the body of an existing card and records a card.updated
// event. Created stays; Updated is bumped to now.
func (s *NoteService) UpdateCard(noteID, cardID, body string) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	n, err := s.readNoteLocked(noteID)
	if err != nil {
		return Document{}, err
	}
	if hasLoneFence(body) {
		return Document{}, errCardFenceInBody
	}

	blocks := parseBlocks(n.Body)
	found := false
	now := time.Now().UTC()
	for i := range blocks {
		if blocks[i].Kind == "card" && blocks[i].Card != nil && blocks[i].Card.ID == cardID {
			blocks[i].Card.Body = strings.Trim(body, "\n")
			blocks[i].Card.Updated = now
			found = true
			break
		}
	}
	if !found {
		return Document{}, fmt.Errorf("card %q not found in note", cardID)
	}

	if err := s.saveBlocksLocked(&n, blocks, now); err != nil {
		return Document{}, err
	}
	if err := s.appendEvent(JournalEvent{
		TS: now, Type: EventCardUpdated, NoteID: n.ID, CardID: cardID, Author: s.currentAuthor(),
	}); err != nil {
		return Document{}, err
	}
	return Document{Note: n, Blocks: blocks}, nil
}

// DeleteCard removes a card from the document and records a card.deleted event.
// The journal keeps the full history, so a deleted card still exists in the
// timeline even though it's gone from the present document.
func (s *NoteService) DeleteCard(noteID, cardID string) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	n, err := s.readNoteLocked(noteID)
	if err != nil {
		return Document{}, err
	}

	blocks := parseBlocks(n.Body)
	kept := make([]Block, 0, len(blocks))
	found := false
	for _, b := range blocks {
		if b.Kind == "card" && b.Card != nil && b.Card.ID == cardID {
			found = true
			continue
		}
		kept = append(kept, b)
	}
	if !found {
		return Document{}, fmt.Errorf("card %q not found in note", cardID)
	}

	now := time.Now().UTC()
	if err := s.saveBlocksLocked(&n, kept, now); err != nil {
		return Document{}, err
	}
	if err := s.appendEvent(JournalEvent{
		TS: now, Type: EventCardDeleted, NoteID: n.ID, CardID: cardID, Author: s.currentAuthor(),
	}); err != nil {
		return Document{}, err
	}
	return Document{Note: n, Blocks: kept}, nil
}

// LinkCards records that card `fromID` references card `toID`, persisting the
// edge on the source card and recording a card.linked event. Both cards must
// exist in the same note. Linking is idempotent (a duplicate edge is a no-op on
// the document but still skipped, not re-journaled).
func (s *NoteService) LinkCards(noteID, fromID, toID string) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if fromID == toID {
		return Document{}, errors.New("a card cannot link to itself")
	}

	n, err := s.readNoteLocked(noteID)
	if err != nil {
		return Document{}, err
	}

	blocks := parseBlocks(n.Body)
	var from *Card
	haveTo := false
	for i := range blocks {
		if blocks[i].Kind != "card" || blocks[i].Card == nil {
			continue
		}
		switch blocks[i].Card.ID {
		case fromID:
			from = blocks[i].Card
		case toID:
			haveTo = true
		}
	}
	if from == nil {
		return Document{}, fmt.Errorf("source card %q not found in note", fromID)
	}
	if !haveTo {
		return Document{}, fmt.Errorf("target card %q not found in note", toID)
	}

	for _, l := range from.Links {
		if l == toID {
			// Edge already exists: return current state, don't double-journal.
			return Document{Note: n, Blocks: blocks}, nil
		}
	}

	now := time.Now().UTC()
	from.Links = append(from.Links, toID)
	from.Updated = now

	if err := s.saveBlocksLocked(&n, blocks, now); err != nil {
		return Document{}, err
	}
	if err := s.appendEvent(JournalEvent{
		TS: now, Type: EventCardLinked, NoteID: n.ID, CardID: fromID, To: toID, Author: s.currentAuthor(),
	}); err != nil {
		return Document{}, err
	}
	return Document{Note: n, Blocks: blocks}, nil
}

// Timeline returns the full chronological journal for the project. The frontend
// groups this into the precise "what happened when" view and, later, the graph.
func (s *NoteService) Timeline() ([]JournalEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return nil, s.rootErr
	}
	return s.readJournal()
}

// ───────────────────────────── internal helpers ─────────────────────────────

// readNoteLocked reads+parses a note by id. Caller must hold s.mu.
func (s *NoteService) readNoteLocked(id string) (Note, error) {
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

// saveBlocksLocked renders blocks back into the note body, bumps Updated and
// writes the note atomically. Caller must hold s.mu.
func (s *NoteService) saveBlocksLocked(n *Note, blocks []Block, now time.Time) error {
	body, err := renderBlocks(blocks)
	if err != nil {
		return err
	}
	n.Body = body
	n.Updated = now
	data, err := n.render()
	if err != nil {
		return fmt.Errorf("render note: %w", err)
	}
	return s.writeAtomic(n.ID, data)
}

// currentAuthor attributes journal events and cards. It prefers the project's
// git user.name, falling back to $USER, then "local". Never fails.
func (s *NoteService) currentAuthor() string {
	cmd := exec.Command("git", "-C", s.root, "config", "user.name")
	if out, err := cmd.Output(); err == nil {
		if name := strings.TrimSpace(string(out)); name != "" {
			return name
		}
	}
	if u := strings.TrimSpace(os.Getenv("USER")); u != "" {
		return u
	}
	return "local"
}
