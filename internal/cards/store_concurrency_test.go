package cards

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// newConcurrentTimeline returns a ready .noteit/timeline.md path inside a temp dir.
func newConcurrentTimeline(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".noteit"), 0o755); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}
	return filepath.Join(dir, ".noteit", "timeline.md")
}

// TestConcurrentAppendsAcrossStores simulates several independent processes (the
// GUI and one or more MCP invocations) appending to the SAME timeline at once.
// Each goroutine uses its OWN Store, so it opens its own lock fd — flock then
// serializes them exactly as it would across processes. Every card must survive
// exactly once and the file must not end up corrupt (no append may be mistaken for
// a torn tail and truncated).
func TestConcurrentAppendsAcrossStores(t *testing.T) {
	path := newConcurrentTimeline(t)

	const writers = 8
	const perWriter = 25
	var wg sync.WaitGroup
	errs := make(chan error, writers*perWriter)

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			st := New(path) // a distinct "process": own state + own lock fd
			for i := 0; i < perWriter; i++ {
				if _, err := st.CreateCard(NewCard{
					Tags: []string{"feat"},
					Body: fmt.Sprintf("w%d-i%d", w, i),
				}); err != nil {
					errs <- fmt.Errorf("writer %d item %d: %w", w, i, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent create failed: %v", err)
	}

	final := New(path)
	if final.corrupt != nil {
		t.Fatalf("timeline corrupted after concurrent writes: %v", final.corrupt)
	}
	list, err := final.ListCards(CardFilter{})
	if err != nil {
		t.Fatalf("list after concurrent writes: %v", err)
	}
	if len(list) != writers*perWriter {
		t.Fatalf("got %d cards, want %d (writes were lost or duplicated)", len(list), writers*perWriter)
	}
	seen := make(map[string]bool, len(list))
	for _, c := range list {
		if seen[c.ID] {
			t.Fatalf("duplicate id survived: %s", c.ID)
		}
		seen[c.ID] = true
		if c.Body == "" {
			t.Fatalf("card %s has empty body (block was mis-parsed)", c.ID)
		}
	}
}

// TestConcurrentReadsDuringAppends hammers a timeline with reads from separate
// Stores while another Store appends. Because reads also refresh under the lock,
// a reader must never observe corruption or a transient error, and the final
// count must be exact.
func TestConcurrentReadsDuringAppends(t *testing.T) {
	path := newConcurrentTimeline(t)
	writer := New(path)

	done := make(chan struct{})
	var wg sync.WaitGroup
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reader := New(path)
			for {
				select {
				case <-done:
					return
				default:
				}
				if _, err := reader.ListCards(CardFilter{}); err != nil {
					t.Errorf("list during concurrent append: %v", err)
					return
				}
			}
		}()
	}

	const n = 60
	for i := 0; i < n; i++ {
		if _, err := writer.CreateCard(NewCard{Tags: []string{"fix"}, Body: fmt.Sprintf("c%d", i)}); err != nil {
			close(done)
			wg.Wait()
			t.Fatalf("append %d: %v", i, err)
		}
	}
	close(done)
	wg.Wait()

	final := New(path)
	if final.corrupt != nil {
		t.Fatalf("timeline corrupted: %v", final.corrupt)
	}
	list, err := final.ListCards(CardFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != n {
		t.Fatalf("got %d cards, want %d", len(list), n)
	}
}
