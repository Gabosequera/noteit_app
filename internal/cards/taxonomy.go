package cards

import (
	"fmt"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Tag taxonomy (data-driven). See docs/v3/taxonomy.md — that doc is the human
// source of truth; this table mirrors it. Adding/renaming a value or synonym is a
// DATA edit here, not a logic change: the resolver below reads this table and has
// no per-axis hardcoding.
//
// 6 axes. `type` and `status` are single-value and always materialized (defaults
// note/todo). priority/horizon/effort are single-value, optional. area is the one
// multi-value, free-text axis: an unrecognized LAST token before the `:` becomes a
// free area value (docs/v3/PLAN.md §1·B); any OTHER unknown token is a hard error.
// ─────────────────────────────────────────────────────────────────────────────

type tagAxis struct {
	name   string
	multi  bool
	values map[string][]string // canonical -> synonyms
}

// taxonomy is the canonical dictionary. Order matters only for deterministic init.
var taxonomy = []tagAxis{
	{
		name: "type", multi: false,
		values: map[string][]string{
			"note":     {"nota", "general"},
			"rem":      {"reminder", "recordatorio", "recordar", "remind"},
			"feat":     {"feature", "new", "add", "nuevo"},
			"fix":      {"bug", "hotfix", "arreglar"},
			"refactor": {"refac", "cleanup", "limpiar"},
			"perf":     {"performance", "optimize"},
			"docs":     {"doc", "readme"},
			"test":     {"tests", "testing"},
			"chore":    {"build", "ci", "config"},
		},
	},
	{
		name: "status", multi: false,
		values: map[string][]string{
			"todo":    {"pendiente", "pending"},
			"doing":   {"wip", "in-progress", "haciendo"},
			"blocked": {"bloqueado", "stuck"},
			"review":  {"in-review", "qa", "pr"},
			"done":    {"hecho", "listo", "closed", "ready", "solved", "resuelto"},
		},
	},
	{
		name: "priority", multi: false,
		values: map[string][]string{
			"p0": {"critical", "urgent", "urgente"},
			"p1": {"high", "alta"},
			"p2": {"medium", "normal"},
			"p3": {"low", "baja"},
		},
	},
	{
		name: "horizon", multi: false,
		values: map[string][]string{
			"now":    {"ahora", "current"},
			"next":   {"siguiente", "upcoming"},
			"future": {"futuro", "later", "missing", "soon"},
		},
	},
	{
		name: "area", multi: true,
		values: map[string][]string{
			"client":   {"frontend", "ui"},
			"backend":  {"server", "back"},
			"api":      {"endpoint", "rest"},
			"data":     {"db", "database", "sql"},
			"infra":    {"ops", "deploy", "devops"},
			"security": {"auth", "sec"},
			"deps":     {"dependencies", "package"},
			"tooling":  {"tools", "cli", "lint"},
		},
	},
	{
		name: "effort", multi: false,
		values: map[string][]string{
			"xs": {"trivial", "tiny"},
			"s":  {"small", "pequeno"},
			"m":  {"mediano"},
			"l":  {"large", "grande"},
		},
	},
}

// ─────────────────────────────── public view ────────────────────────────────

// AxisInfo is a stable, serializable description of one tag axis, exposed so
// external clients (notably the MCP describe_taxonomy tool) can present the
// controlled vocabulary to an AI agent without it having to guess valid tokens.
type AxisInfo struct {
	Name    string      `json:"name"`
	Multi   bool        `json:"multi"`             // true only for `area` (0-N values)
	Default string      `json:"default,omitempty"` // canonical default, if the axis has one
	Values  []AxisValue `json:"values"`
}

// AxisValue is one canonical value of an axis plus the synonyms that resolve to it.
type AxisValue struct {
	Canonical string   `json:"canonical"`
	Synonyms  []string `json:"synonyms,omitempty"`
}

// axisDefaults are the canonical defaults applied for an axis when the user omits
// it: type/status are always materialized on disk; horizon's `now` is applied on
// read (never written). Mirrors resolveTags + withDefaults.
var axisDefaults = map[string]string{"type": "note", "status": "todo", "horizon": "now"}

// Taxonomy returns the controlled tag vocabulary in a deterministic, serializable
// form (axes in declaration order; canonical values and synonyms sorted). It reads
// the same table the resolver uses, so it can never drift from validation.
func Taxonomy() []AxisInfo {
	out := make([]AxisInfo, 0, len(taxonomy))
	for _, ax := range taxonomy {
		canon := make([]string, 0, len(ax.values))
		for c := range ax.values {
			canon = append(canon, c)
		}
		sort.Strings(canon)
		vals := make([]AxisValue, 0, len(canon))
		for _, c := range canon {
			syns := append([]string(nil), ax.values[c]...)
			sort.Strings(syns)
			vals = append(vals, AxisValue{Canonical: c, Synonyms: syns})
		}
		out = append(out, AxisInfo{
			Name:    ax.name,
			Multi:   ax.multi,
			Default: axisDefaults[ax.name],
			Values:  vals,
		})
	}
	return out
}

// tagMatch is a resolved (axis, canonical) pair for one input token.
type tagMatch struct {
	axis      string
	canonical string
	multi     bool
}

// tokenIndex maps a normalized token (canonical or synonym) to its match. Built
// once at init; a token mapping to two different axes is a dictionary bug and
// panics at startup so we catch it immediately.
var tokenIndex = buildTokenIndex()

func buildTokenIndex() map[string]tagMatch {
	idx := map[string]tagMatch{}
	add := func(token string, m tagMatch) {
		token = normalizeToken(token)
		if prev, ok := idx[token]; ok && (prev.axis != m.axis || prev.canonical != m.canonical) {
			panic(fmt.Sprintf("taxonomy: token %q maps to both %s:%s and %s:%s",
				token, prev.axis, prev.canonical, m.axis, m.canonical))
		}
		idx[token] = m
	}
	for _, ax := range taxonomy {
		for canonical, syns := range ax.values {
			m := tagMatch{axis: ax.name, canonical: canonical, multi: ax.multi}
			add(canonical, m)
			for _, s := range syns {
				add(s, m)
			}
		}
	}
	return idx
}

// normalizeToken: lowercase + strip accents. Mirrors the parse rule in taxonomy.md.
func normalizeToken(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		if rep, ok := accentFold[r]; ok {
			b.WriteString(rep)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// accentFold covers the Spanish-relevant accented runes (no external dep).
var accentFold = map[rune]string{
	'á': "a", 'é': "e", 'í': "i", 'ó': "o", 'ú': "u", 'ü': "u", 'ñ': "n",
	'à': "a", 'è': "e", 'ì': "i", 'ò': "o", 'ù': "u",
}

// resolveTags maps order-preserving raw tokens to a Tags value (PLAN.md §1·B).
//
//   - recognized token -> its axis canonical; single-value axis with a conflicting
//     second value -> hard error (no override).
//   - area canonical/synonym -> appended (multi).
//   - an UNRECOGNIZED *last* token -> free area value.
//   - any OTHER unrecognized token -> hard error naming it. (The frontend's
//     two-Enter "confirm & drop" UX simply re-calls with that token removed.)
//
// type/status defaults (note/todo) are filled. horizon's logical `now` default is
// NOT applied here (it is applied on read so it is never written to disk).
func resolveTags(tokens []string) (Tags, error) {
	t := Tags{Type: "note", Status: "todo"}
	typeSet, statusSet := false, false
	prioritySet, horizonSet, effortSet := false, false, false

	// Pre-filter empty/blank tokens so the "last token" rule below refers to the
	// last MEANINGFUL token, not a trailing "" the caller happened to send.
	type entry struct{ raw, norm string }
	entries := make([]entry, 0, len(tokens))
	for _, raw := range tokens {
		norm := normalizeToken(raw)
		if norm == "" {
			continue
		}
		entries = append(entries, entry{raw: strings.TrimSpace(raw), norm: norm})
	}
	lastIdx := len(entries) - 1

	for i, e := range entries {
		m, ok := tokenIndex[e.norm]
		if !ok {
			if i == lastIdx {
				// Free area value (the one free slot). Preserve the user's ORIGINAL
				// text (area is free-text): don't lowercase/accent-fold it.
				t.Area = appendUnique(t.Area, e.raw)
				continue
			}
			return Tags{}, fmt.Errorf("unknown tag %q", e.raw)
		}
		switch m.axis {
		case "type":
			if typeSet && t.Type != m.canonical {
				return Tags{}, fmt.Errorf("conflicting type: %q and %q", t.Type, m.canonical)
			}
			t.Type, typeSet = m.canonical, true
		case "status":
			if statusSet && t.Status != m.canonical {
				return Tags{}, fmt.Errorf("conflicting status: %q and %q", t.Status, m.canonical)
			}
			t.Status, statusSet = m.canonical, true
		case "priority":
			if prioritySet && t.Priority != m.canonical {
				return Tags{}, fmt.Errorf("conflicting priority: %q and %q", t.Priority, m.canonical)
			}
			t.Priority, prioritySet = m.canonical, true
		case "horizon":
			if horizonSet && t.Horizon != m.canonical {
				return Tags{}, fmt.Errorf("conflicting horizon: %q and %q", t.Horizon, m.canonical)
			}
			t.Horizon, horizonSet = m.canonical, true
		case "effort":
			if effortSet && t.Effort != m.canonical {
				return Tags{}, fmt.Errorf("conflicting effort: %q and %q", t.Effort, m.canonical)
			}
			t.Effort, effortSet = m.canonical, true
		case "area":
			t.Area = appendUnique(t.Area, m.canonical)
		}
	}
	if len(t.Area) > 0 {
		sort.Strings(t.Area)
	}
	return t, nil
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}
