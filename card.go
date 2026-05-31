package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─────────────────────────────── card model ───────────────────────────────
//
// A note is a *document*: an ordered sequence of blocks that interleaves plain
// prose with timestamped "status cards" (the `space space` / `:**` cards). The
// note's Markdown file stays the single source of truth for the CURRENT state —
// cards are stored inline in the body so prose can wrap around them and ordering
// is positional, exactly like the hand-drawn sketch (Texto, card, Texto, card).
//
// History (who created/edited/deleted/linked what, and when) is NOT derived from
// the note file: it lives in an append-only journal (journal.go). The note file
// answers "what does this document look like now"; the journal answers "what
// happened, in what order, before/after". The two never fight because the
// journal is never rewritten.

// Card is one status card embedded in a note document. Content, metadata and
// ordering all come from the inline fence in the note body — there is no second
// copy anywhere, so a card can never drift out of sync with itself.
type Card struct {
	ID      string    `json:"id"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
	Author  string    `json:"author,omitempty"`
	// Links are the IDs of other cards this card references. Rendering these as a
	// graph is a later piece; here we only persist the edges.
	Links []string `json:"links,omitempty"`
	// Body is the card's content (status text and/or code), preserved byte-for-byte
	// between the fence lines except for outer blank lines (the fence delimiters
	// own those). It may span multiple lines but must not contain a line equal to
	// the bare close fence (enforced on write).
	Body string `json:"body"`
}

// Block is one element of a rendered document: either a run of plain prose
// ("text") or a card ("card"). The frontend walks Blocks in order to render the
// interleaved document. Blocks is a projection of Note.Body — disposable, never
// persisted on its own.
type Block struct {
	Kind string `json:"kind"`           // "text" | "card"
	Text string `json:"text,omitempty"` // set when Kind == "text"
	Card *Card  `json:"card,omitempty"` // set when Kind == "card"
}

const (
	cardFenceOpen  = ":::card"
	cardFenceClose = ":::"
)

// errCardFenceInBody guards content that would break the fence round-trip. The
// service layer surfaces this rather than silently corrupting a document.
var errCardFenceInBody = fmt.Errorf("card content may not contain a line equal to %q", cardFenceClose)

// errCardMutationInProseSave guards the prose-save path (SaveDocument) against
// card lifecycle changes. Cards may only be created/updated/deleted/linked
// through the journaled methods (AddCard/UpdateCard/DeleteCard/LinkCards) so the
// timeline stays complete. SaveDocument therefore rejects any block list whose
// cards differ — in count, order, or content — from what is already on disk.
var errCardMutationInProseSave = errors.New("SaveDocument may not add, remove, reorder, or edit cards; use the card methods")

// parseBlocks splits a note body into ordered prose/card blocks. It is tolerant:
// any text outside a well-formed card fence is preserved as a text block, and an
// unterminated fence is treated as prose (so a half-typed document never loses
// data). It is the inverse of renderBlocks for canonically-rendered bodies.
func parseBlocks(body string) []Block {
	lines := strings.Split(body, "\n")
	var blocks []Block
	var text []string

	flushText := func() {
		if len(text) == 0 {
			return
		}
		joined := strings.Trim(strings.Join(text, "\n"), "\n")
		if joined != "" {
			blocks = append(blocks, Block{Kind: "text", Text: joined})
		}
		text = text[:0]
	}

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if !strings.HasPrefix(strings.TrimRight(line, "\r"), cardFenceOpen+" ") &&
			strings.TrimRight(line, "\r") != cardFenceOpen {
			text = append(text, line)
			continue
		}

		// Find the matching close fence.
		closeAt := -1
		for j := i + 1; j < len(lines); j++ {
			if strings.TrimRight(lines[j], "\r") == cardFenceClose {
				closeAt = j
				break
			}
		}
		if closeAt < 0 {
			// Unterminated fence: treat the rest as prose, don't lose it.
			text = append(text, line)
			continue
		}

		card, ok := parseCardHeader(strings.TrimRight(line, "\r"))
		if !ok {
			// Malformed header: keep as prose rather than fabricate a card.
			text = append(text, line)
			continue
		}
		card.Body = strings.Trim(strings.Join(lines[i+1:closeAt], "\n"), "\n")

		flushText()
		c := card
		blocks = append(blocks, Block{Kind: "card", Card: &c})
		i = closeAt
	}
	flushText()
	return blocks
}

// parseCardHeader parses a `:::card id=… created=… updated=… author=… links=a,b`
// line into a Card (without Body). Values are space-delimited; tokens that may
// contain spaces (author) are percent-encoded on write and decoded here. Unknown
// keys are ignored. A header is rejected (ok=false, kept as prose) unless `id` is
// a canonical UUID — this stops a hand-typed or pasted fence from fabricating a
// card. Link targets that are not UUIDs are dropped.
func parseCardHeader(line string) (Card, bool) {
	rest := strings.TrimSpace(strings.TrimPrefix(line, cardFenceOpen))
	if rest == "" {
		return Card{}, false
	}
	var c Card
	for _, tok := range strings.Fields(rest) {
		key, val, ok := strings.Cut(tok, "=")
		if !ok {
			continue
		}
		switch key {
		case "id":
			c.ID = val
		case "created":
			if t, err := time.Parse(time.RFC3339Nano, val); err == nil {
				c.Created = t
			}
		case "updated":
			if t, err := time.Parse(time.RFC3339Nano, val); err == nil {
				c.Updated = t
			}
		case "author":
			if dec, err := url.QueryUnescape(val); err == nil {
				c.Author = dec
			} else {
				c.Author = val
			}
		case "links":
			for _, l := range strings.Split(val, ",") {
				if _, err := uuid.Parse(l); err == nil {
					c.Links = append(c.Links, l)
				}
			}
		}
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return Card{}, false
	}
	return c, true
}

// renderCard serializes one card to its canonical inline fence. Timestamps are
// RFC3339/UTC so the on-disk form is stable and sortable.
func renderCard(c Card) (string, error) {
	if hasLoneFence(c.Body) {
		return "", errCardFenceInBody
	}
	var h strings.Builder
	h.WriteString(cardFenceOpen)
	h.WriteString(" id=" + c.ID)
	if !c.Created.IsZero() {
		h.WriteString(" created=" + c.Created.UTC().Format(time.RFC3339Nano))
	}
	if !c.Updated.IsZero() {
		h.WriteString(" updated=" + c.Updated.UTC().Format(time.RFC3339Nano))
	}
	if c.Author != "" {
		// Percent-encode so names with spaces (e.g. "Gabriel Sequera") survive the
		// space-delimited header and no value can inject a newline or extra field.
		h.WriteString(" author=" + url.QueryEscape(c.Author))
	}
	if len(c.Links) > 0 {
		h.WriteString(" links=" + strings.Join(c.Links, ","))
	}
	h.WriteString("\n")
	body := strings.Trim(c.Body, "\n")
	if body != "" {
		h.WriteString(body)
		h.WriteString("\n")
	}
	h.WriteString(cardFenceClose)
	return h.String(), nil
}

// renderBlocks serializes an ordered block list back into a canonical body:
// blocks separated by a single blank line, cards as fences. It is the inverse of
// parseBlocks for round-tripping.
func renderBlocks(blocks []Block) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		switch b.Kind {
		case "card":
			if b.Card == nil {
				continue
			}
			s, err := renderCard(*b.Card)
			if err != nil {
				return "", err
			}
			parts = append(parts, s)
		default:
			t := strings.Trim(b.Text, "\n")
			if t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n\n"), nil
}

// hasLoneFence reports whether any line equals the bare close fence, which would
// break fence parsing if embedded in card content.
func hasLoneFence(body string) bool {
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimRight(line, "\r") == cardFenceClose {
			return true
		}
	}
	return false
}
