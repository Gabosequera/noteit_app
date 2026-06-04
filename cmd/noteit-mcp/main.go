// Command noteit-mcp is a standalone Model Context Protocol (MCP) server that
// exposes a project's noteit card timeline to an AI agent over stdio. It is a
// second, independent front-end over the very same internal/cards.Store that the
// Wails GUI uses, so an agent and the desktop app share one append-only timeline
// and can never disagree about storage semantics. Because the Store takes a
// dedicated interprocess lock on every operation, the agent and the GUI may run at
// the same time against the same vault.
//
// Protocol discipline: stdout carries ONLY the JSON-RPC stream; every log line
// goes to stderr. A single byte of stray stdout would corrupt the protocol.
//
// Vault resolution mirrors the GUI (internal/vault): an explicit --vault flag wins,
// then $NOTEIT_PROJECT, then the nearest .git ancestor of the working directory,
// then the working directory itself. A mistyped --vault/$NOTEIT_PROJECT fails loudly
// rather than silently scattering a new .noteit/ somewhere unexpected.
package main

import (
	"context"
	"flag"
	"log"
	"os"

	"github.com/Gabosequera/noteit_app/internal/cards"
	"github.com/Gabosequera/noteit_app/internal/vault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// version is reported to MCP clients in the server handshake.
const version = "0.1.0"

// grammarHelp is a compact reminder of the tag grammar, surfaced through
// describe_taxonomy so an agent can author cards correctly in one round-trip.
const grammarHelp = "A card is tags + a Markdown body. Tags are controlled tokens " +
	"resolved against the axes below (case- and accent-insensitive; English and " +
	"Spanish synonyms allowed). type and status are always present (defaults note/todo); " +
	"priority, horizon, effort are optional single values; area is multi-value and the " +
	"only free-text axis — an unrecognized token is accepted as a free area value only " +
	"if it is the LAST tag, otherwise it is rejected. Bodies are immutable once created: " +
	"there is no update or delete, only create."

func main() {
	log.SetFlags(0)
	log.SetPrefix("noteit-mcp: ")
	log.SetOutput(os.Stderr) // stdout is reserved for the JSON-RPC protocol stream

	vaultFlag := flag.String("vault", "",
		"project root that owns the .noteit vault (default: $NOTEIT_PROJECT, nearest .git ancestor, then cwd)")
	flag.Parse()

	root, err := vault.Resolve(*vaultFlag)
	if err != nil {
		log.Fatalf("resolve vault: %v", err)
	}
	if err := vault.EnsureNoteitDir(root); err != nil {
		log.Fatalf("prepare vault: %v", err)
	}
	store := cards.New(vault.TimelinePath(root))
	log.Printf("serving cards for vault %s", root)

	server := mcp.NewServer(&mcp.Implementation{Name: "noteit", Version: version}, nil)
	registerTools(server, store)

	// Run blocks until stdin closes (the client disconnected) or the context is
	// cancelled. A clean EOF returns nil.
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}

// ─────────────────────────────── tool I/O types ─────────────────────────────

type createCardInput struct {
	Tags []string `json:"tags,omitempty" jsonschema:"controlled tag tokens, e.g. [\"feat\",\"p1\",\"doing\",\"backend\"]; call describe_taxonomy for the vocabulary. An unrecognized LAST token becomes a free-text area value."`
	Body string   `json:"body" jsonschema:"the card content as Markdown; required and non-empty. Do not include a title."`

	RefID   string `json:"refId,omitempty" jsonschema:"optional uuid of an existing card to relate this one to"`
	RefKind string `json:"refKind,omitempty" jsonschema:"relationship to refId: \"link\" (default) or \"parent\" (this card is nested under refId)"`
}

type listCardsInput struct {
	Type     string `json:"type,omitempty" jsonschema:"filter by card type (e.g. feat, fix, note)"`
	Status   string `json:"status,omitempty" jsonschema:"filter by status (e.g. todo, doing, done)"`
	Priority string `json:"priority,omitempty" jsonschema:"filter by priority (p0-p3)"`
	Horizon  string `json:"horizon,omitempty" jsonschema:"filter by horizon (now, next, future)"`
	Effort   string `json:"effort,omitempty" jsonschema:"filter by effort (xs, s, m, l)"`
	Area     string `json:"area,omitempty" jsonschema:"filter to cards carrying this area value"`
}

type listCardsOutput struct {
	Count int          `json:"count"`
	Cards []cards.Card `json:"cards"`
}

type getCardInput struct {
	ID string `json:"id" jsonschema:"the uuid of the card to fetch; returns it with derived backlinks and children"`
}

// taxonomyInput intentionally has no fields: describe_taxonomy takes no arguments.
type taxonomyInput struct{}

type taxonomyOutput struct {
	Grammar string           `json:"grammar"`
	Axes    []cards.AxisInfo `json:"axes"`
}

// ─────────────────────────────── registration ───────────────────────────────

// registerTools wires the four card tools onto the server. Each handler delegates
// to the shared Store (which reloads fresh under the interprocess lock per call),
// and returns store validation failures as ERRORS so the SDK reports them as tool
// errors the agent can read and self-correct, not as protocol-level failures.
func registerTools(s *mcp.Server, store *cards.Store) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "create_card",
		Description: "Append a new immutable card (a tagged Markdown note) to the project timeline. Cards cannot be edited or deleted afterward.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in createCardInput) (*mcp.CallToolResult, cards.Card, error) {
		card, err := store.CreateCard(cards.NewCard{
			Tags:    in.Tags,
			Body:    in.Body,
			RefID:   in.RefID,
			RefKind: in.RefKind,
		})
		if err != nil {
			return nil, cards.Card{}, err
		}
		return nil, card, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_cards",
		Description: "List cards in creation order (the timeline), optionally filtered by any combination of the tag axes. Returns lightweight cards without derived backlinks/children.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in listCardsInput) (*mcp.CallToolResult, listCardsOutput, error) {
		list, err := store.ListCards(cards.CardFilter{
			Type:     in.Type,
			Status:   in.Status,
			Priority: in.Priority,
			Horizon:  in.Horizon,
			Effort:   in.Effort,
			Area:     in.Area,
		})
		if err != nil {
			return nil, listCardsOutput{}, err
		}
		return nil, listCardsOutput{Count: len(list), Cards: list}, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "get_card",
		Description: "Fetch a single card by id, including derived backlinks (cards that link to it) and children (cards nested under it).",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in getCardInput) (*mcp.CallToolResult, cards.Card, error) {
		card, err := store.GetCard(in.ID)
		if err != nil {
			return nil, cards.Card{}, err
		}
		return nil, card, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "describe_taxonomy",
		Description: "Return the controlled tag vocabulary (the 6 axes, their canonical values and synonyms) plus the tag grammar. Call this first to learn valid tags before creating cards.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, _ taxonomyInput) (*mcp.CallToolResult, taxonomyOutput, error) {
		return nil, taxonomyOutput{Grammar: grammarHelp, Axes: cards.Taxonomy()}, nil
	})
}
