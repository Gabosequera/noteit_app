package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"
	"time"

	"github.com/Gabosequera/noteit_app/internal/cards"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// decodeStructured re-marshals a tool result's structured output into v. The
// typed handlers populate CallToolResult.StructuredContent automatically.
func decodeStructured(t *testing.T, res *mcp.CallToolResult, v any) {
	t.Helper()
	if res.StructuredContent == nil {
		t.Fatalf("result has no structured content: %+v", res.Content)
	}
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatalf("marshal structured content: %v", err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("unmarshal structured content: %v", err)
	}
}

// TestMCPServerEndToEnd boots the actual noteit-mcp binary as a subprocess and
// drives it through the real MCP stdio protocol with the SDK client: handshake,
// tools/list, describe_taxonomy, create_card, list_cards, get_card, and an
// error path. This proves stdout carries clean protocol (a stray log byte would
// break the handshake) and that the four tools are wired to the store correctly.
func TestMCPServerEndToEnd(t *testing.T) {
	vaultDir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// `go run .` compiles and runs this package; --vault pins the vault so the
	// test never touches the developer's real project or home directory.
	cmd := exec.Command("go", "run", ".", "--vault", vaultDir)

	client := mcp.NewClient(&mcp.Implementation{Name: "smoke", Version: "0"}, nil)
	sess, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatalf("connect to server: %v", err)
	}
	defer sess.Close()

	// tools/list — all four tools must be advertised.
	lt, err := sess.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	got := map[string]bool{}
	for _, tool := range lt.Tools {
		got[tool.Name] = true
	}
	for _, want := range []string{"create_card", "list_cards", "get_card", "describe_taxonomy"} {
		if !got[want] {
			t.Errorf("tool %q not advertised", want)
		}
	}

	// describe_taxonomy — must return the 6 axes.
	dt, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "describe_taxonomy", Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("describe_taxonomy: %v", err)
	}
	if dt.IsError {
		t.Fatalf("describe_taxonomy is error: %+v", dt.Content)
	}
	var tax taxonomyOutput
	decodeStructured(t, dt, &tax)
	if len(tax.Axes) != 6 || tax.Grammar == "" {
		t.Fatalf("taxonomy looks wrong: %d axes, grammar=%q", len(tax.Axes), tax.Grammar)
	}

	// create_card — synonyms resolve, defaults apply.
	cr, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "create_card", Arguments: map[string]any{
		"tags": []string{"feature", "high", "haciendo", "server"},
		"body": "wire the MCP server to the card store",
	}})
	if err != nil {
		t.Fatalf("create_card: %v", err)
	}
	if cr.IsError {
		t.Fatalf("create_card is error: %+v", cr.Content)
	}
	var created cards.Card
	decodeStructured(t, cr, &created)
	if created.ID == "" {
		t.Fatal("created card has empty id")
	}
	if created.Tags.Type != "feat" || created.Tags.Priority != "p1" ||
		created.Tags.Status != "doing" || len(created.Tags.Area) != 1 || created.Tags.Area[0] != "backend" {
		t.Fatalf("tags not resolved as expected: %+v", created.Tags)
	}

	// list_cards — filter by status should find the card we just made.
	lc, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "list_cards", Arguments: map[string]any{"status": "doing"}})
	if err != nil {
		t.Fatalf("list_cards: %v", err)
	}
	var listed listCardsOutput
	decodeStructured(t, lc, &listed)
	if listed.Count != 1 || len(listed.Cards) != 1 || listed.Cards[0].ID != created.ID {
		t.Fatalf("list_cards filter wrong: count=%d", listed.Count)
	}

	// get_card — round-trips the id and applies the read-time horizon default.
	gc, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "get_card", Arguments: map[string]any{"id": created.ID}})
	if err != nil {
		t.Fatalf("get_card: %v", err)
	}
	var fetched cards.Card
	decodeStructured(t, gc, &fetched)
	if fetched.ID != created.ID || fetched.Tags.Horizon != "now" {
		t.Fatalf("get_card wrong: id=%q horizon=%q", fetched.ID, fetched.Tags.Horizon)
	}

	// error path — an empty body is a TOOL error (IsError), not a transport error,
	// so the agent can read it and self-correct.
	ec, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "create_card", Arguments: map[string]any{"body": "   "}})
	if err != nil {
		t.Fatalf("create_card(empty) transport error: %v", err)
	}
	if !ec.IsError {
		t.Fatal("expected empty-body create_card to be a tool error")
	}

	// error path — a malformed controlled filter must surface as a TOOL error
	// (not a silent empty list that would make the agent think the timeline is
	// empty) while leaving the session alive for the next call.
	bf, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "list_cards", Arguments: map[string]any{"status": "nonsense"}})
	if err != nil {
		t.Fatalf("list_cards(bad filter) transport error: %v", err)
	}
	if !bf.IsError {
		t.Fatal("expected an unknown status filter to be a tool error")
	}

	// error path — a refKind without a refId must be a TOOL error, so the caller's
	// relationship intent is never silently dropped.
	rk, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "create_card", Arguments: map[string]any{
		"body": "orphan ref", "refKind": "parent",
	}})
	if err != nil {
		t.Fatalf("create_card(refKind w/o refId) transport error: %v", err)
	}
	if !rk.IsError {
		t.Fatal("expected refKind without refId to be a tool error")
	}
}
