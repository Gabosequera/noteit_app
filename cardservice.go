package main

import (
	"log"

	"github.com/Gabosequera/noteit_app/internal/cards"
	"github.com/Gabosequera/noteit_app/internal/vault"
)

// CardService is the Wails-bound adapter for noteit v3 cards. The append-only
// card timeline itself lives in internal/cards.Store (transport-agnostic); this
// type only resolves the vault once and forwards calls. The MCP server
// (cmd/noteit-mcp) is a second, independent adapter over the very same Store
// implementation, so the GUI and an AI agent can never disagree about storage
// semantics or framing.
//
// It is a SEPARATE Wails service from NoteService (notes are the secondary,
// mutable text surface; cards are the primary, immutable surface).
type CardService struct {
	store   *cards.Store
	initErr error // vault could not be resolved/prepared → every call fails with this
}

// NewCardService resolves the project root, ensures the vault, and opens the
// timeline. If the root can't be resolved or the vault prepared, the service is
// returned in a degraded state where every method returns the recorded error
// (mirroring the old behavior so the app still launches).
func NewCardService() *CardService {
	root, err := vault.Discover()
	if err != nil {
		log.Printf("noteit cards: project root unresolved: %v", err)
		return &CardService{initErr: err}
	}
	if err := vault.EnsureNoteitDir(root); err != nil {
		log.Printf("noteit cards: ensure vault failed: %v", err)
		return &CardService{initErr: err}
	}
	return &CardService{store: cards.New(vault.TimelinePath(root))}
}

// CreateCard appends a new immutable card. See cards.Store.CreateCard.
func (s *CardService) CreateCard(in cards.NewCard) (cards.Card, error) {
	if s.store == nil {
		return cards.Card{}, s.initErr
	}
	return s.store.CreateCard(in)
}

// ListCards returns the timeline in creation order, optionally filtered.
func (s *CardService) ListCards(filter cards.CardFilter) ([]cards.Card, error) {
	if s.store == nil {
		return nil, s.initErr
	}
	return s.store.ListCards(filter)
}

// GetCard returns one card with derived backlinks/children.
func (s *CardService) GetCard(id string) (cards.Card, error) {
	if s.store == nil {
		return cards.Card{}, s.initErr
	}
	return s.store.GetCard(id)
}
