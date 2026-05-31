package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// ─────────────────────────────── timeline journal ───────────────────────────
//
// The journal is an append-only newline-delimited JSON log at
// .noteit/journal.ndjson. Every card lifecycle event (created / updated /
// deleted / linked) is appended with a UTC timestamp and never rewritten. This
// is the source of truth for the timeline and the future card graph: the note
// files tell us the present, the journal tells us the history. Because we only
// ever append, two writers can't corrupt prior history and the timeline can be
// rebuilt from scratch by replaying the file.

// Journal event types. Stored as strings so the log stays human-readable and
// forward-compatible (an unknown type is skipped on read, not fatal).
const (
	EventCardCreated = "card.created"
	EventCardUpdated = "card.updated"
	EventCardDeleted = "card.deleted"
	EventCardLinked  = "card.linked"
)

// JournalEvent is one immutable line in the timeline log.
type JournalEvent struct {
	TS     time.Time `json:"ts"`
	Type   string    `json:"type"`
	NoteID string    `json:"noteID"`
	CardID string    `json:"cardID"`
	// To is the target card for a link event; empty otherwise.
	To string `json:"to,omitempty"`
	// Author is who triggered the event, for attribution in the timeline.
	Author string `json:"author,omitempty"`
}

func (s *NoteService) journalPath() string {
	return s.noteitDir() + string(os.PathSeparator) + "journal.ndjson"
}

// appendEvent appends one event to the journal. It opens with O_APPEND so the
// write is atomic for small lines on local filesystems, and fsyncs so a crash
// can't lose a just-recorded event. Callers already hold s.mu.
func (s *NoteService) appendEvent(ev JournalEvent) error {
	if ev.TS.IsZero() {
		ev.TS = time.Now().UTC()
	}
	line, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal journal event: %w", err)
	}
	f, err := os.OpenFile(s.journalPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open journal: %w", err)
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append journal: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync journal: %w", err)
	}
	return nil
}

// readJournal replays the whole journal in file (chronological) order. Because we
// append+fsync one event per line, the ONLY line that may be malformed is the
// final one (a write torn by a crash) — that single tail line is tolerated. A
// malformed line anywhere before the end means real corruption and is reported
// with its line number rather than silently dropping history. Every parseable
// event is returned regardless of Type, so a reader written today does not choke
// on event types introduced by a future version (forward-compatible).
func (s *NoteService) readJournal() ([]JournalEvent, error) {
	f, err := os.Open(s.journalPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []JournalEvent{}, nil
		}
		return nil, fmt.Errorf("open journal: %w", err)
	}
	defer f.Close()

	// Collect non-empty lines first so we can tell which one is the last.
	type rawLine struct {
		no   int
		data []byte
	}
	var lines []rawLine
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		b := sc.Bytes()
		if len(b) == 0 {
			continue
		}
		lines = append(lines, rawLine{no: lineNo, data: append([]byte(nil), b...)})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("scan journal: %w", err)
	}

	events := make([]JournalEvent, 0, len(lines))
	for i, rl := range lines {
		var ev JournalEvent
		if err := json.Unmarshal(rl.data, &ev); err != nil {
			if i == len(lines)-1 {
				break // tolerate a torn final write
			}
			return events, fmt.Errorf("journal corrupted at line %d: %w", rl.no, err)
		}
		events = append(events, ev)
	}
	return events, nil
}
