package cards

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

// Store is the append-only card timeline backing one vault. Cards are immutable,
// append-only journal entries stored as readable Markdown in a single file
// (timeline.md). The Store is transport-agnostic: it receives an explicit,
// already-resolved timeline path (project-root discovery lives in internal/vault)
// and knows nothing about Wails or MCP — both are thin adapters over this type.
//
// Contract: docs/v3/PLAN.md §1 (entity), §2 (storage) and §2·B (framing/durability).
type Store struct {
	mu       sync.Mutex
	path     string // .noteit/timeline.md (the caller ensures the parent dir exists)
	lockPath string // .noteit/timeline.lock (dedicated interprocess lock file)
	corrupt  error  // mid-file corruption found at load → writes refused (D.5)

	cards []Card         // in creation (append) order
	index map[string]int // id -> position in cards
}

// New constructs a Store for the timeline at path. The lock file lives beside it
// (timeline.lock in the same .noteit/ dir). It then performs an initial load under
// the interprocess lock: a torn tail is truncated; mid-file corruption is recorded
// and blocks future writes (the file is left untouched). The caller MUST have
// created the parent .noteit/ directory first (see vault.EnsureNoteitDir).
//
// All on-disk inspection happens under the lock (never eagerly without it) so a
// concurrent external append is never mistaken for a torn tail and truncated.
func New(path string) *Store {
	s := &Store{
		path:     path,
		lockPath: filepath.Join(filepath.Dir(path), "timeline.lock"),
		index:    map[string]int{},
	}
	if err := s.guarded(func() error { return nil }); err != nil {
		log.Printf("noteit cards: timeline load error (writes disabled): %v", err)
		return s
	}
	log.Printf("noteit cards: timeline ready at %s (%d cards)", s.path, len(s.cards))
	return s
}

// guarded runs fn while holding BOTH the in-process mutex and the exclusive
// interprocess file lock, after re-reading the timeline FRESH from disk. This
// single critical section is what makes load/torn-tail-recovery + append + fsync
// atomic across processes: while we hold the lock no other noteit process can
// append, so any tail we see is genuinely torn (never an in-flight external
// write), and the state fn observes is always the latest committed timeline.
//
// We deliberately reload on every call rather than caching by size+modtime: the
// timeline is human-readable and may be hand-edited or restored from backup, where
// a same-size / equal-mtime change would defeat such a cache and let us append to
// content we never parsed. Correctness beats skipping a re-parse; for v1 card
// volumes the cost is negligible and a robust change-detector can be added later.
func (s *Store) guarded(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	release, err := acquireFileLock(s.lockPath)
	if err != nil {
		return fmt.Errorf("acquire timeline lock: %w", err)
	}
	defer release()

	if err := s.load(); err != nil {
		return err
	}
	return fn()
}

// load reads timeline.md, parses every block, and atomically replaces the
// in-memory state. It is reload-safe: it parses into LOCAL slices/maps and only
// commits them (and clears/sets s.corrupt) once the outcome is known, so a failed
// reload never leaves a half-parsed prefix or stale-vs-fresh mismatch behind.
//
// A torn tail (D.5) is truncated on disk before any append can happen; mid-file
// corruption poisons the store (writes refused) and leaves the previous good
// state and the file untouched. Any load error sets s.corrupt; a clean load
// clears it (so a store can recover if the timeline is repaired/replaced).
func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		// No file yet: create an empty timeline durably, then commit empty state.
		// (Done BEFORE touching live state so a create failure can't lose it.)
		if cerr := s.createEmpty(); cerr != nil {
			s.corrupt = cerr
			return cerr
		}
		s.cards, s.index, s.corrupt = nil, map[string]int{}, nil
		return nil
	}
	if err != nil {
		s.corrupt = fmt.Errorf("read timeline: %w", err)
		return s.corrupt
	}

	// Parse into LOCAL state; live state stays intact until we succeed.
	cards := make([]Card, 0, len(s.cards))
	index := make(map[string]int)
	pos := 0
	for pos < len(data) {
		card, next, perr := parseBlock(data, pos)
		if perr != nil {
			if errors.Is(perr, errTornTail) {
				// Torn append at EOF: truncate to the last complete block, then
				// proceed (D.5). Only the tail can ever be incomplete.
				if pos < len(data) {
					if terr := os.Truncate(s.path, int64(pos)); terr != nil {
						s.corrupt = fmt.Errorf("truncate torn tail: %w", terr)
						return s.corrupt
					}
					if ferr := fsyncFile(s.path); ferr != nil {
						s.corrupt = fmt.Errorf("fsync after torn-tail truncate: %w", ferr)
						return s.corrupt
					}
					log.Printf("noteit cards: discarded torn tail at offset %d", pos)
				}
				break
			}
			// Complete-but-malformed block somewhere in the file: poison the store
			// and leave both the previous good state and the file untouched.
			s.corrupt = fmt.Errorf("mid-file corruption: %w", perr)
			return s.corrupt
		}
		if _, dup := index[card.ID]; dup {
			// Duplicate id (manual edit): first wins, warn (D.7).
			log.Printf("noteit cards: duplicate id %s ignored", card.ID)
			pos = next
			continue
		}
		index[card.ID] = len(cards)
		cards = append(cards, card)
		pos = next
	}

	// Commit: atomically replace state and clear any prior poison.
	s.cards, s.index, s.corrupt = cards, index, nil
	return nil
}

// createEmpty creates timeline.md and fsyncs both the file and its directory so
// the new directory entry survives a crash (D.6).
func (s *Store) createEmpty() error {
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
	return fsyncDir(filepath.Dir(s.path))
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

// ─────────────────────────────── public API ─────────────────────────────────

// NewCard is the structured input for CreateCard. Tags are raw, order-preserving
// tokens (the store resolves them, PLAN.md §1·B). RefID/RefKind are flat so the
// generated Wails bindings stay simple.
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
func (s *Store) CreateCard(in NewCard) (Card, error) {
	var out Card
	err := s.guarded(func() error {
		c, e := s.createCardLocked(in)
		out = c
		return e
	})
	return out, err
}

// createCardLocked is the body of CreateCard; the caller (guarded) holds both the
// in-process mutex and the interprocess lock and has already refreshed state.
func (s *Store) createCardLocked(in NewCard) (Card, error) {
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
	} else if strings.TrimSpace(in.RefKind) != "" {
		// A refKind with no refId is a caller mistake: it would be silently
		// dropped, producing an unlinked card. Reject it so the mistake surfaces.
		return Card{}, fmt.Errorf("refKind %q set without a refId", strings.TrimSpace(in.RefKind))
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
func (s *Store) appendBlock(card Card) error {
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
func (s *Store) rollback(size int64) {
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
func (s *Store) ListCards(filter CardFilter) ([]Card, error) {
	// Validate/normalize the filter BEFORE touching disk: an unknown controlled
	// value (e.g. a typo'd status) is rejected loudly instead of silently matching
	// nothing, which an AI agent could not distinguish from "no cards yet".
	filter, err := normalizeFilter(filter)
	if err != nil {
		return nil, err
	}
	var out []Card
	err = s.guarded(func() error {
		out = make([]Card, 0, len(s.cards))
		for _, c := range s.cards {
			if !matchesFilter(c, filter) {
				continue
			}
			out = append(out, s.withDefaults(c))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// GetCard returns one card by id with derived backlinks (incoming kind=link) and
// children (incoming kind=parent) computed from the whole store (D.7/D.8).
func (s *Store) GetCard(id string) (Card, error) {
	var card Card
	err := s.guarded(func() error {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("invalid id: %w", err)
		}
		pos, ok := s.index[id]
		if !ok {
			return fmt.Errorf("card %s not found", id)
		}
		card = s.withDefaults(s.cards[pos])

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
		return nil
	})
	if err != nil {
		return Card{}, err
	}
	return card, nil
}

// writable reports whether the store can accept appends.
func (s *Store) writable() error {
	if s.corrupt != nil {
		return fmt.Errorf("timeline is corrupt, refusing to write: %w", s.corrupt)
	}
	return nil
}

// withDefaults returns a copy of the card with read-time logical defaults applied
// (horizon → now). These defaults are never written to disk (PLAN.md §1·B).
func (s *Store) withDefaults(c Card) Card {
	if c.Tags.Horizon == "" {
		c.Tags.Horizon = "now"
	}
	return c
}

// normalizeFilter validates each controlled filter field against the taxonomy and
// rewrites it to its canonical form, so a synonym filter (status=resuelto) matches
// the canonical stored on cards (done) and an unrecognized value is a clear error.
// The area axis is free-text/multi: a known synonym is canonicalized, but an
// unrecognized value is kept verbatim because it may be a legitimate free area.
func normalizeFilter(f CardFilter) (CardFilter, error) {
	var err error
	if f.Type, err = resolveFilterValue("type", f.Type); err != nil {
		return f, err
	}
	if f.Status, err = resolveFilterValue("status", f.Status); err != nil {
		return f, err
	}
	if f.Priority, err = resolveFilterValue("priority", f.Priority); err != nil {
		return f, err
	}
	if f.Horizon, err = resolveFilterValue("horizon", f.Horizon); err != nil {
		return f, err
	}
	if f.Effort, err = resolveFilterValue("effort", f.Effort); err != nil {
		return f, err
	}
	if f.Area, err = resolveAreaFilter(f.Area); err != nil {
		return f, err
	}
	return f, nil
}

// resolveFilterValue maps a controlled-axis filter value to its canonical form.
// An empty value means "no filter". A value that resolves to a DIFFERENT axis, or
// to nothing, is rejected so the caller learns it mistyped.
func resolveFilterValue(axis, value string) (string, error) {
	norm := normalizeToken(value)
	if norm == "" {
		return "", nil
	}
	m, ok := tokenIndex[norm]
	if !ok || m.axis != axis {
		return "", fmt.Errorf("unknown %s filter %q", axis, strings.TrimSpace(value))
	}
	return m.canonical, nil
}

// resolveAreaFilter canonicalizes a known area synonym and preserves a genuinely
// unknown value as a free-text area (areas are user-defined). A value that is a
// KNOWN token of a DIFFERENT axis (e.g. "feat" is a type) is rejected: it can never
// be stored as a free area by CreateCard, so filtering by it would silently return
// an empty list and mislead the caller into thinking the timeline is empty.
func resolveAreaFilter(value string) (string, error) {
	norm := normalizeToken(value)
	if norm == "" {
		return "", nil
	}
	if m, ok := tokenIndex[norm]; ok {
		if m.axis != "area" {
			return "", fmt.Errorf("unknown area filter %q (it is a %s value)", strings.TrimSpace(value), m.axis)
		}
		return m.canonical, nil
	}
	return strings.TrimSpace(value), nil
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
