package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// CardService is the Wails-bound backend for noteit v3 cards. Cards are immutable,
// append-only journal entries stored as readable Markdown in .noteit/timeline.md.
// It is a SEPARATE Wails service from NoteService (notes are the secondary, mutable
// text surface; cards are the primary, immutable surface).
//
// Contract: docs/v3/PLAN.md §1 (entity), §2 (storage) and §2·B (framing/durability).
type CardService struct {
	mu      sync.Mutex
	root    string // resolved project root (dir that contains .noteit/)
	rootErr error  // project root could not be safely resolved
	corrupt error  // mid-file corruption found at load → writes refused (D.5)
	path    string // .noteit/timeline.md

	cards []Card         // in creation (append) order
	index map[string]int // id -> position in cards
}

// NewCardService resolves the project root, ensures the vault, and loads the
// timeline once into an in-memory index. A torn tail is truncated; mid-file
// corruption is recorded and blocks future writes (the file is left untouched).
func NewCardService() *CardService {
	s := &CardService{index: map[string]int{}}
	root, err := resolveProjectRoot()
	if err != nil {
		s.rootErr = err
		log.Printf("noteit cards: project root unresolved: %v", err)
		return s
	}
	s.root = root
	s.path = filepath.Join(root, ".noteit", "timeline.md")
	if err := s.ensureVault(); err != nil {
		s.rootErr = err
		log.Printf("noteit cards: ensureVault failed: %v", err)
		return s
	}
	if err := s.load(); err != nil {
		s.corrupt = err
		log.Printf("noteit cards: timeline load error (writes disabled): %v", err)
		return s
	}
	log.Printf("noteit cards: timeline ready at %s (%d cards)", s.path, len(s.cards))
	return s
}

func (s *CardService) noteitDir() string { return filepath.Join(s.root, ".noteit") }

// ensureVault makes .noteit/ and the private-by-default .gitignore. (NoteService
// does the same for notes/; cards are self-sufficient so order doesn't matter.)
func (s *CardService) ensureVault() error {
	if err := os.MkdirAll(s.noteitDir(), 0o755); err != nil {
		return fmt.Errorf("mkdir .noteit: %w", err)
	}
	gitignore := filepath.Join(s.noteitDir(), ".gitignore")
	if _, err := os.Stat(gitignore); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(gitignore, []byte("*\n"), 0o644); err != nil {
			return fmt.Errorf("write .gitignore: %w", err)
		}
	}
	return nil
}

// load reads timeline.md, parses every block, and builds the index. A torn tail
// (D.5) is truncated on disk before any append can happen; mid-file corruption is
// returned as an error (the caller disables writes and leaves the file intact).
func (s *CardService) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		// Create an empty timeline durably so the directory entry is persisted.
		return s.createEmpty()
	}
	if err != nil {
		return fmt.Errorf("read timeline: %w", err)
	}

	pos := 0
	for pos < len(data) {
		card, next, perr := parseBlock(data, pos)
		if perr != nil {
			if errors.Is(perr, errTornTail) {
				// Torn append at EOF: truncate to the last complete block, then
				// proceed (D.5). Only the tail can ever be incomplete.
				if pos < len(data) {
					if terr := os.Truncate(s.path, int64(pos)); terr != nil {
						return fmt.Errorf("truncate torn tail: %w", terr)
					}
					if ferr := fsyncFile(s.path); ferr != nil {
						return fmt.Errorf("fsync after torn-tail truncate: %w", ferr)
					}
					log.Printf("noteit cards: discarded torn tail at offset %d", pos)
				}
				break
			}
			// Complete-but-malformed block somewhere in the file: refuse to start
			// writing (don't make it worse). Surface as an explicit error.
			return fmt.Errorf("mid-file corruption: %w", perr)
		}
		if _, dup := s.index[card.ID]; dup {
			// Duplicate id (manual edit): first wins, warn (D.7).
			log.Printf("noteit cards: duplicate id %s ignored", card.ID)
			pos = next
			continue
		}
		s.index[card.ID] = len(s.cards)
		s.cards = append(s.cards, card)
		pos = next
	}
	return nil
}

// createEmpty creates timeline.md and fsyncs both the file and its directory so
// the new directory entry survives a crash (D.6).
func (s *CardService) createEmpty() error {
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create timeline: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("sync timeline: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close timeline: %w", err)
	}
	return fsyncDir(s.noteitDir())
}

// fsyncDir fsyncs a directory so a newly-created file's directory entry is durable.
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open dir for fsync: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("fsync dir: %w", err)
	}
	return nil
}

// ─────────────────────────────── Wails API ──────────────────────────────────

// NewCard is the structured input for CreateCard. Tags are raw, order-preserving
// tokens (the backend resolves them, PLAN.md §1·B). RefID/RefKind are flat so the
// generated bindings stay simple.
type NewCard struct {
	Tags    []string `json:"tags"`
	Body    string   `json:"body"`
	RefID   string   `json:"refId"`
	RefKind string   `json:"refKind"` // "" | "link" | "parent"
}

// CardFilter narrows ListCards. Empty fields are ignored. Area matches if the card
// has the given area among its values.
type CardFilter struct {
	Type     string `json:"type"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
	Horizon  string `json:"horizon"`
	Effort   string `json:"effort"`
	Area     string `json:"area"`
}

// CreateCard validates input, resolves tags, assigns a uuid v7 id + timestamp,
// appends the block durably, and updates the index. Cards are immutable: there is
// deliberately no UpdateCard/DeleteCard.
func (s *CardService) CreateCard(in NewCard) (Card, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return Card{}, err
	}

	body := strings.TrimRight(in.Body, "\n")
	if strings.TrimSpace(body) == "" {
		return Card{}, errors.New("card body is empty")
	}

	tags, err := resolveTags(in.Tags)
	if err != nil {
		return Card{}, err
	}

	var ref *Ref
	if rid := strings.TrimSpace(in.RefID); rid != "" {
		if _, err := uuid.Parse(rid); err != nil {
			return Card{}, fmt.Errorf("invalid ref id: %w", err)
		}
		if _, ok := s.index[rid]; !ok {
			return Card{}, fmt.Errorf("ref target %s does not exist", rid)
		}
		kind := strings.TrimSpace(in.RefKind)
		if kind == "" {
			kind = RefLink
		}
		if kind != RefLink && kind != RefParent {
			return Card{}, fmt.Errorf("invalid ref kind %q", kind)
		}
		ref = &Ref{ID: rid, Kind: kind}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return Card{}, fmt.Errorf("generate id: %w", err)
	}

	card := Card{
		ID:      id.String(),
		Created: time.Now().UTC(),
		Body:    body,
		Tags:    tags,
		Ref:     ref,
	}

	if err := s.appendBlock(card); err != nil {
		return Card{}, err
	}
	s.index[card.ID] = len(s.cards)
	s.cards = append(s.cards, card)

	return s.withDefaults(card), nil
}

// appendBlock writes one serialized block to the end of timeline.md in a single
// Write, checks for a short write, and fsyncs before returning. Only on success
// does the caller update the in-memory index (D.6).
func (s *CardService) appendBlock(card Card) error {
	block := card.serialize()

	// Remember the last known-good size so a failed/partial append can be rolled
	// back. We are the only writer (under s.mu), so this size is stable.
	info, statErr := os.Stat(s.path)
	if statErr != nil {
		return fmt.Errorf("stat timeline: %w", statErr)
	}
	oldSize := info.Size()

	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open timeline for append: %w", err)
	}
	n, werr := f.Write(block)
	if werr != nil || n != len(block) {
		f.Close()
		s.rollback(oldSize) // a partial tail may be on disk — remove it
		if werr != nil {
			return fmt.Errorf("append card: %w", werr)
		}
		return fmt.Errorf("short write: wrote %d of %d bytes", n, len(block))
	}
	if err := f.Sync(); err != nil {
		f.Close()
		s.rollback(oldSize)
		return fmt.Errorf("fsync timeline: %w", err)
	}
	if err := f.Close(); err != nil {
		s.rollback(oldSize)
		return fmt.Errorf("close timeline: %w", err)
	}
	return nil
}

// rollback truncates a partially-written tail back to the last known-good size and
// fsyncs, so a failed append never turns a recoverable torn tail into mid-file
// corruption on the next load. If rollback itself fails, the store is poisoned to
// refuse further writes. Caller holds s.mu.
func (s *CardService) rollback(size int64) {
	if err := os.Truncate(s.path, size); err != nil {
		s.corrupt = fmt.Errorf("append failed and rollback failed: %w", err)
		log.Printf("noteit cards: rollback truncate failed, writes disabled: %v", err)
		return
	}
	if err := fsyncFile(s.path); err != nil {
		s.corrupt = fmt.Errorf("append failed and rollback fsync failed: %w", err)
		log.Printf("noteit cards: rollback fsync failed, writes disabled: %v", err)
	}
}

// fsyncFile opens a file just to fsync it (used after truncate operations, whose
// size change must be flushed to be durable).
func fsyncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// ListCards returns cards in creation order (the timeline), optionally filtered.
// Derived backlinks/children are NOT filled here (cheap list); use GetCard for those.
func (s *CardService) ListCards(filter CardFilter) ([]Card, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return nil, s.rootErr
	}
	if s.corrupt != nil {
		return nil, s.corrupt
	}

	out := make([]Card, 0, len(s.cards))
	for _, c := range s.cards {
		if !matchesFilter(c, filter) {
			continue
		}
		out = append(out, s.withDefaults(c))
	}
	return out, nil
}

// GetCard returns one card by id with derived backlinks (incoming kind=link) and
// children (incoming kind=parent) computed from the whole store (D.7/D.8).
func (s *CardService) GetCard(id string) (Card, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootErr != nil {
		return Card{}, s.rootErr
	}
	if s.corrupt != nil {
		return Card{}, s.corrupt
	}
	if _, err := uuid.Parse(id); err != nil {
		return Card{}, fmt.Errorf("invalid id: %w", err)
	}
	pos, ok := s.index[id]
	if !ok {
		return Card{}, fmt.Errorf("card %s not found", id)
	}
	card := s.withDefaults(s.cards[pos])

	for _, other := range s.cards {
		if other.Ref == nil || other.Ref.ID != id {
			continue
		}
		if other.Ref.Kind == RefParent {
			card.Children = append(card.Children, other.ID)
		} else {
			card.Backlinks = append(card.Backlinks, other.ID)
		}
	}
	return card, nil
}

// writable reports whether the store can accept appends.
func (s *CardService) writable() error {
	if s.rootErr != nil {
		return s.rootErr
	}
	if s.corrupt != nil {
		return fmt.Errorf("timeline is corrupt, refusing to write: %w", s.corrupt)
	}
	return nil
}

// withDefaults returns a copy of the card with read-time logical defaults applied
// (horizon → now). These defaults are never written to disk (PLAN.md §1·B).
func (s *CardService) withDefaults(c Card) Card {
	if c.Tags.Horizon == "" {
		c.Tags.Horizon = "now"
	}
	return c
}

func matchesFilter(c Card, f CardFilter) bool {
	horizon := c.Tags.Horizon
	if horizon == "" {
		horizon = "now"
	}
	if f.Type != "" && c.Tags.Type != f.Type {
		return false
	}
	if f.Status != "" && c.Tags.Status != f.Status {
		return false
	}
	if f.Priority != "" && c.Tags.Priority != f.Priority {
		return false
	}
	if f.Horizon != "" && horizon != f.Horizon {
		return false
	}
	if f.Effort != "" && c.Tags.Effort != f.Effort {
		return false
	}
	if f.Area != "" {
		found := false
		for _, a := range c.Tags.Area {
			if a == f.Area {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
