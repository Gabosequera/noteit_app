package cards

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// Card entity (noteit v3). See docs/v3/PLAN.md §1 and §2·B.
//
// A Card is a first-class, immutable, append-only journal entry. It is stored as
// readable Markdown in .noteit/timeline.md using a length-framed block:
//
//	> CARD | id:<uuidv7> | created:<rfc3339nano> | type:.. | status:.. | … | bytes:<N>
//	<body — EXACTLY N bytes of UTF-8, opaque, no escaping>
//	> ENDCARD <id>
//
// The body is framed by `bytes:N` (D.3): the parser reads exactly N bytes, so the
// body can contain anything (---, lines starting with `>`, even a line that looks
// like a `> CARD` header) without being misread. The footer `> ENDCARD <id>`
// (D.4) proves the block was written completely; a block missing its footer can
// only be a torn write at the very end of the file (D.5).
// ─────────────────────────────────────────────────────────────────────────────

// Card is the in-memory shape of a timeline entry. It is immutable once created.
type Card struct {
	ID      string    `json:"id"`      // uuid v7 — identity and coarse time order
	Created time.Time `json:"created"` // RFC3339Nano — human-readable timestamp
	Body    string    `json:"body"`    // markdown, opaque; the "what". No title.
	Tags    Tags      `json:"tags"`    // 6 controlled axes (taxonomy.md)
	Ref     *Ref      `json:"ref,omitempty"`

	// Derived fields — NOT stored on disk; filled by the service on read.
	Backlinks []string `json:"backlinks,omitempty"` // ids that ref this card with kind=link
	Children  []string `json:"children,omitempty"`  // ids that ref this card with kind=parent
}

// Ref is a single outgoing reference to another card. kind=parent expresses
// nesting (this card is filed under the target); kind=link is a neutral link.
type Ref struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "link" (default) | "parent"
}

const (
	RefLink   = "link"
	RefParent = "parent"
)

// Tags is the per-axis tag map. type/status are always materialized (defaults
// note/todo); the rest only when set. horizon's logical default `now` is applied
// on read by the service, not stored, so an absent horizon stays absent on disk.
type Tags struct {
	Type     string   `json:"type"`               // required, default note
	Status   string   `json:"status"`             // required, default todo
	Priority string   `json:"priority,omitempty"` // 0-1
	Horizon  string   `json:"horizon,omitempty"`  // 0-1, logical default now
	Area     []string `json:"area,omitempty"`     // 0-N, free text allowed
	Effort   string   `json:"effort,omitempty"`   // 0-1
}

// ─────────────────────────────── serialization ──────────────────────────────

const (
	cardHeaderPrefix = "> CARD"
	cardFooterPrefix = "> ENDCARD "
)

// serialize renders a card into its on-disk block: header line, exactly the body
// bytes, an explicit separator newline, the footer line, and a trailing newline.
// The separator before the footer is always written (D.4) — we never rely on the
// body ending in a newline.
func (c Card) serialize() []byte {
	body := []byte(c.Body)

	var h strings.Builder
	h.WriteString(cardHeaderPrefix)
	h.WriteString(" | id:")
	h.WriteString(c.ID)
	h.WriteString(" | created:")
	h.WriteString(c.Created.Format(time.RFC3339Nano))
	h.WriteString(" | type:")
	h.WriteString(c.Tags.Type)
	h.WriteString(" | status:")
	h.WriteString(c.Tags.Status)
	if c.Tags.Priority != "" {
		h.WriteString(" | priority:")
		h.WriteString(c.Tags.Priority)
	}
	if c.Tags.Horizon != "" {
		h.WriteString(" | horizon:")
		h.WriteString(c.Tags.Horizon)
	}
	if len(c.Tags.Area) > 0 {
		h.WriteString(" | area:")
		for i, a := range c.Tags.Area {
			if i > 0 {
				h.WriteByte(',')
			}
			h.WriteString(encodeAreaValue(a))
		}
	}
	if c.Tags.Effort != "" {
		h.WriteString(" | effort:")
		h.WriteString(c.Tags.Effort)
	}
	if c.Ref != nil && c.Ref.ID != "" {
		h.WriteString(" | ref:")
		h.WriteString(c.Ref.ID)
		if c.Ref.Kind == RefParent {
			h.WriteString(":")
			h.WriteString(RefParent)
		}
	}
	// bytes is always last and always present (D.1).
	h.WriteString(" | bytes:")
	h.WriteString(strconv.Itoa(len(body)))

	out := make([]byte, 0, h.Len()+len(body)+len(cardFooterPrefix)+len(c.ID)+3)
	out = append(out, h.String()...)
	out = append(out, '\n')
	out = append(out, body...)
	out = append(out, '\n') // explicit separator before footer
	out = append(out, cardFooterPrefix...)
	out = append(out, c.ID...)
	out = append(out, '\n')
	return out
}

// ──────────────────────────────── parsing ───────────────────────────────────

// errTornTail signals an incomplete block at end-of-file (a torn append). The
// caller truncates the file to the last complete block and continues (D.5).
var errTornTail = errors.New("torn block at end of timeline")

// knownHeaderKeys is the set of header keys we recognize (D.1). A header with any
// other key is invalid. We validate KEYS, not values (each card has its own).
var knownHeaderKeys = map[string]bool{
	"id": true, "created": true, "type": true, "status": true,
	"priority": true, "horizon": true, "area": true, "effort": true,
	"ref": true, "bytes": true,
}

// parseBlock parses exactly one card block starting at data[pos]. It returns the
// card and the offset just past the block. A torn tail (premature EOF) returns
// errTornTail; a complete-but-malformed block returns a descriptive error that
// the caller treats as mid-file corruption.
func parseBlock(data []byte, pos int) (Card, int, error) {
	// 1. Header line — must be terminated by a newline.
	nl := indexByteFrom(data, pos, '\n')
	if nl < 0 {
		return Card{}, pos, errTornTail // header line never completed
	}
	headerLine := string(data[pos:nl])
	card, bodyLen, err := parseHeader(headerLine)
	if err != nil {
		return Card{}, pos, fmt.Errorf("invalid card header at offset %d: %w", pos, err)
	}
	bodyStart := nl + 1

	// 2. Body — exactly bodyLen bytes (D.3). Compare without computing
	// bodyStart+bodyLen first: a huge bytes:N (manual edit) would overflow int
	// and wrap negative, defeating a `> len(data)` check and panicking the slice.
	if bodyLen > len(data)-bodyStart {
		return Card{}, pos, errTornTail // body shorter than declared bytes
	}
	bodyEnd := bodyStart + bodyLen
	card.Body = string(data[bodyStart:bodyEnd])

	// 3. Separator newline before the footer (D.4).
	if bodyEnd >= len(data) {
		return Card{}, pos, errTornTail // separator not yet written
	}
	if data[bodyEnd] != '\n' {
		// Declared length lands mid-content: framing is internally inconsistent.
		return Card{}, pos, fmt.Errorf("card %s: byte after %d-byte body is not the separator", card.ID, bodyLen)
	}
	sepEnd := bodyEnd + 1

	// 4. Footer line — must be terminated and must match `> ENDCARD <id>`.
	footNl := indexByteFrom(data, sepEnd, '\n')
	if footNl < 0 {
		return Card{}, pos, errTornTail // footer line never completed
	}
	footerLine := string(data[sepEnd:footNl])
	want := cardFooterPrefix + card.ID
	if footerLine != want {
		return Card{}, pos, fmt.Errorf("card %s: footer mismatch (got %q)", card.ID, footerLine)
	}
	return card, footNl + 1, nil
}

// parseHeader parses a `> CARD | …` header line into a Card (body still empty)
// plus the declared body length. It validates the structure and KEYS, never the
// tag VALUES (D.1) — except structural fields (id, created, bytes, ref).
func parseHeader(line string) (Card, int, error) {
	if !strings.HasPrefix(line, cardHeaderPrefix) {
		return Card{}, 0, errors.New("missing > CARD prefix")
	}
	rest := strings.TrimPrefix(line, cardHeaderPrefix)
	if !strings.HasPrefix(rest, " | ") {
		return Card{}, 0, errors.New("no header fields")
	}
	tokens := strings.Split(strings.TrimPrefix(rest, " | "), " | ")

	var (
		c        Card
		bytesN   = -1
		seen     = map[string]bool{}
		haveByte bool
	)
	for _, tok := range tokens {
		key, val, found := strings.Cut(tok, ":")
		if !found {
			return Card{}, 0, fmt.Errorf("token %q is not key:value", tok)
		}
		if !knownHeaderKeys[key] {
			return Card{}, 0, fmt.Errorf("unknown header key %q", key)
		}
		if seen[key] {
			return Card{}, 0, fmt.Errorf("duplicate header key %q", key)
		}
		seen[key] = true

		switch key {
		case "id":
			if _, err := uuid.Parse(val); err != nil {
				return Card{}, 0, fmt.Errorf("bad id %q", val)
			}
			c.ID = val
		case "created":
			t, err := time.Parse(time.RFC3339Nano, val)
			if err != nil {
				return Card{}, 0, fmt.Errorf("bad created %q", val)
			}
			c.Created = t
		case "type":
			c.Tags.Type = val
		case "status":
			c.Tags.Status = val
		case "priority":
			c.Tags.Priority = val
		case "horizon":
			c.Tags.Horizon = val
		case "area":
			c.Tags.Area = decodeAreaList(val)
		case "effort":
			c.Tags.Effort = val
		case "ref":
			rid, kind, found := strings.Cut(val, ":")
			if _, err := uuid.Parse(rid); err != nil {
				return Card{}, 0, fmt.Errorf("bad ref id %q", rid)
			}
			// The writer only ever emits a bare id (link) or exactly "id:parent".
			// Anything else — a typo, an extra ":suffix", or even a trailing ":" that
			// yields an explicitly empty kind — is corruption, not a silently
			// downgraded link, so reject it and drop the block. We use `found` to tell
			// a genuinely absent kind ("<uuid>") from an empty one ("<uuid>:").
			switch {
			case !found:
				kind = RefLink
			case kind == RefLink || kind == RefParent:
				// ok
			default:
				return Card{}, 0, fmt.Errorf("bad ref kind %q", kind)
			}
			c.Ref = &Ref{ID: rid, Kind: kind}
		case "bytes":
			n, err := strconv.Atoi(val)
			if err != nil || n < 0 {
				return Card{}, 0, fmt.Errorf("bad bytes %q", val)
			}
			bytesN = n
			haveByte = true
		}
	}

	// Required keys (D.1).
	if c.ID == "" || c.Created.IsZero() || c.Tags.Type == "" || c.Tags.Status == "" || !haveByte {
		return Card{}, 0, errors.New("missing required header field (id, created, type, status, bytes)")
	}
	return c, bytesN, nil
}

// indexByteFrom returns the index of the first b in data at or after `from`, or
// -1. Mirrors bytes.IndexByte but on a sub-slice without allocating.
func indexByteFrom(data []byte, from int, b byte) int {
	for i := from; i < len(data); i++ {
		if data[i] == b {
			return i
		}
	}
	return -1
}

// ─────────────────────────── area percent-encoding ──────────────────────────
// area is the one free-text axis (D.2). Its values are percent-encoded so they
// can never contain a `,` (the multi separator), a ` | ` (the header separator),
// or a newline that would break the single-line header.

func encodeAreaValue(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' || c == '|' || c == ',' || c == '\n' || c == '\r' {
			fmt.Fprintf(&b, "%%%02X", c)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

func decodeAreaValue(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if hi, ok := hexVal(s[i+1]); ok {
				if lo, ok2 := hexVal(s[i+2]); ok2 {
					b.WriteByte(hi<<4 | lo)
					i += 2
					continue
				}
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func decodeAreaList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		out = append(out, decodeAreaValue(p))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	}
	return 0, false
}
