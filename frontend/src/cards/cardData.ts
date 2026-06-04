/* ───────────────────────── noteit · card data layer (v3) ─────────────────────────
   Bridges the real CardService model (6 controlled axes, immutable, append-only)
   onto the view-model the concept GUI renders. The concept colored *free* hashtags
   by convention; we color *controlled axes* by axis — the look survives, the model
   stays as decided in PLAN.md (no author, axes not free tags, ref{id,kind}).        */

import type { Card as BCard, Tags as BTags } from "../../bindings/github.com/Gabosequera/noteit_app/models.js";
import { resolveToken } from "./taxonomy.js";

/* ── one chip on a card: a single axis value with its color + axis label ── */
export interface CardChip {
    label: string;   // the canonical token shown in the chip (e.g. "feat", "p0")
    color: string;   // chip accent color
    axis: string;    // which axis it came from (type/status/priority/…)
}

/* ── the view-model the timeline/doc renderers consume ── */
export interface CardVM {
    id: string;
    shortId: string;
    created: number;        // epoch ms (0 if unparseable)
    body: string;
    chips: CardChip[];
    railColor: string;      // left-rail / dot color = the card's "kind"
    refId: string | null;   // outgoing ref target
    refKind: string;        // "" | "link" | "parent"
    backlinks: string[];    // incoming kind=link (only filled by GetCard)
    children: string[];     // incoming kind=parent (only filled by GetCard)
    raw?: BCard;            // the original, for round-trips (absent on preview VMs)
}

/* ── a card the composer is about to link to (parent or sibling link) ── */
export interface LinkTarget {
    id: string;
    shortId: string;
    body: string;
    kind: "link" | "parent";
}

/* ════════════════ axis → color ════════════════
   The card's primary color communicates the KIND of work, exactly like the
   concept. Source of truth is the `type` axis (feat/fix/refactor/…), with
   horizon=future promoted to violet (the concept's "future/idea" hue). */

const TYPE_COLOR: Record<string, string> = {
    feat: "#3fb950",
    fix: "#f0883e",
    refactor: "#39c5cf",
    perf: "#db61a2",
    docs: "#58a6ff",
    test: "#e3b341",
    chore: "#8b949e",
    rem: "#bc8cff",
    note: "#8b949e",
};
const STATUS_COLOR: Record<string, string> = {
    todo: "#bc8cff",
    doing: "#e3b341",
    blocked: "#f85149",
    review: "#58a6ff",
    done: "#3fb950",
};
const PRIORITY_COLOR: Record<string, string> = {
    p0: "#f85149",
    p1: "#f0883e",
    p2: "#e3b341",
    p3: "#8b949e",
};
const HORIZON_COLOR: Record<string, string> = {
    now: "#8b949e",
    next: "#58a6ff",
    future: "#bc8cff",
};
const NEUTRAL = "#8b949e";
const AREA_COLOR = "#39c5cf";
const EFFORT_COLOR = "#8b949e";

export function typeColor(type: string): string {
    return TYPE_COLOR[type] ?? NEUTRAL;
}

/* the card's "kind" color: future horizon wins (it reads as a different class of
   work), otherwise the type axis drives it. */
function railColorFor(t: BTags): string {
    if (t.horizon === "future") return HORIZON_COLOR.future;
    return typeColor(t.type || "note");
}

/* flatten the 6 axes into ordered, colored chips. type+status always show; the
   optional axes only when set. This is the surface that lets the controlled model
   read like the concept's colored hashtag chips. */
export function tagsToChips(t: BTags): CardChip[] {
    const chips: CardChip[] = [];
    if (t.type) chips.push({ label: t.type, color: typeColor(t.type), axis: "type" });
    if (t.status) chips.push({ label: t.status, color: STATUS_COLOR[t.status] ?? NEUTRAL, axis: "status" });
    if (t.priority) chips.push({ label: t.priority, color: PRIORITY_COLOR[t.priority] ?? NEUTRAL, axis: "priority" });
    if (t.horizon && t.horizon !== "now") chips.push({ label: t.horizon, color: HORIZON_COLOR[t.horizon] ?? NEUTRAL, axis: "horizon" });
    (t.area ?? []).forEach((a) => chips.push({ label: a, color: AREA_COLOR, axis: "area" }));
    if (t.effort) chips.push({ label: t.effort, color: EFFORT_COLOR, axis: "effort" });
    return chips;
}

/* ════════════════ time helpers (mirror the concept's data.jsx) ════════════════ */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/* the Go time.Time serializes as an RFC3339 string; tolerate already-number too. */
function toEpoch(created: unknown): number {
    if (typeof created === "number") return created;
    if (!created) return 0;
    const d = new Date(created as string);
    const t = d.getTime();
    return isNaN(t) ? 0 : t;
}

export function fmtTime(ms: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function fmtDay(ms: number): string {
    if (!ms) return "—";
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
export function fmtClock(): string {
    const d = new Date();
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function shortId(id: string): string {
    return (id || "").replace(/-/g, "").slice(0, 4);
}

/* ════════════════ map binding → view-model ════════════════ */
export function mapCard(c: BCard): CardVM {
    const t = c.tags ?? ({} as BTags);
    return {
        id: c.id,
        shortId: shortId(c.id),
        created: toEpoch(c.created),
        body: c.body ?? "",
        chips: tagsToChips(t),
        railColor: railColorFor(t),
        refId: c.ref ? c.ref.id : null,
        refKind: c.ref ? c.ref.kind : "",
        backlinks: c.backlinks ?? [],
        children: c.children ?? [],
        raw: c,
    };
}

/* ════════════════ day grouping (preserve creation order) ════════════════ */
export interface DayGroup { day: string; items: CardVM[]; }
export function groupByDay(cards: CardVM[]): DayGroup[] {
    const groups: DayGroup[] = [];
    for (const c of cards) {
        const day = fmtDay(c.created);
        let g = groups[groups.length - 1];
        if (!g || g.day !== day) { g = { day, items: [] }; groups.push(g); }
        g.items.push(c);
    }
    return groups;
}

/* ════════════════ body highlight (ported from concept data.jsx) ════════════════
   Each line is rendered as code or prose. Returns HTML; callers inject it into a
   pre-escaped container, so every dynamic segment is escaped here. */
function esc(s: string): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KEYWORDS = new Set([
    "func", "fn", "let", "const", "var", "if", "else", "elif", "return", "async", "await",
    "class", "def", "import", "from", "for", "while", "pub", "struct", "enum", "impl", "match",
    "type", "interface", "new", "public", "private", "self", "export", "default", "try", "catch",
    "throw", "package", "go", "map", "range", "nil", "null", "true", "false", "None", "True", "False",
    "and", "or", "not", "in", "is", "switch", "case", "break", "continue", "yield", "static", "void",
]);

function isCodeLine(line: string): boolean {
    const t = line.trim();
    if (!t) return false;
    if (/^[#>\-*]\s|^\d+\.\s/.test(t)) return false;
    if (/[{};]|=>|->|::|\)\s*\{|\(\)/.test(line)) return true;
    if (/^\s{2,}\S/.test(line)) return true;
    const first = t.split(/[\s(]/)[0];
    return KEYWORDS.has(first);
}

function tokenizeCode(line: string): string {
    const re = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b([A-Za-z_]\w*)\b(\s*\()?|(\d+(?:\.\d+)?)/g;
    let out = "", last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        out += esc(line.slice(last, m.index));
        if (m[1]) out += `<span class="tk-cmt">${esc(m[1])}</span>`;
        else if (m[2]) out += `<span class="tk-str">${esc(m[2])}</span>`;
        else if (m[3]) {
            const w = m[3];
            if (KEYWORDS.has(w)) out += `<span class="tk-key">${esc(w)}</span>`;
            else if (m[4]) out += `<span class="tk-fn">${esc(w)}</span>${esc(m[4])}`;
            else if (/^[A-Z]/.test(w)) out += `<span class="tk-type">${esc(w)}</span>`;
            else out += esc(w);
        } else if (m[5]) out += `<span class="tk-num">${esc(m[5])}</span>`;
        last = re.lastIndex;
    }
    out += esc(line.slice(last));
    return out;
}

function tokenizeProse(line: string): string {
    let html = esc(line);
    html = html.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    html = html.replace(/(^|[\s(])#([A-Za-z][\w-]*)/g,
        (_m, pre, t) => `${pre}<span class="ln-tag" style="color:${typeColor(String(t).toLowerCase())}">#${t}</span>`);
    return html;
}

export function highlightBody(body: string): string {
    return String(body).split("\n").map((l) => (isCodeLine(l) ? tokenizeCode(l) : tokenizeProse(l))).join("\n");
}

/* first non-empty line of a body — used for ref previews + sidebar fragments. */
export function firstLine(body: string): string {
    return String(body).split("\n").find((l) => l.trim()) ?? "";
}

/* ════════════════ composer input parsing ════════════════
   PRIMARY grammar (PLAN.md §1·B):  `tags : body`
     · everything BEFORE the first `:` is the tag section — plain, space-separated words,
       NO `+`/`#` sigil needed (sigils are tolerated for muscle memory and stripped);
     · everything AFTER that first `:` is the body, VERBATIM — any further `:` is literal
       and never re-splits (only the FIRST colon divides).
   The colon only divides when the left side actually looks like a tag section (every
   token is a bare word) and the colon is not part of a `://` URL — so prose/code/URLs
   that happen to contain a `:` are left intact as body.

   FALLBACK (no tag-section colon): legacy inline `+tag`/`#tag` sigils, with `#tags`
   kept inline in the body so highlightBody can still color them. This keeps old habits
   working and means a plain note with no tags and no colon is just its own body. */
export interface ParsedCardInput { body: string; tags: string[]; }

const TAG_TOKEN = /^[#+]?[A-Za-z][\w-]*$/;

/* index of the first `:` that separates a tag section from the body, or -1. */
function tagBodyColon(raw: string): number {
    const idx = raw.indexOf(":");
    if (idx < 0) return -1;
    if (raw[idx + 1] === "/") return -1;             // `://` — a URL, not a separator
    const left = raw.slice(0, idx).trim();
    if (!left) return -1;                            // ":body" — empty tag section
    return left.split(/\s+/).every((t) => TAG_TOKEN.test(t)) ? idx : -1;
}

export function parseCardInput(raw: string): ParsedCardInput {
    const idx = tagBodyColon(raw);
    if (idx >= 0) {
        const tags = raw.slice(0, idx).trim().split(/\s+/)
            .map((t) => t.replace(/^[#+]/, "").toLowerCase())  // tolerate (and strip) +/# sigils
            .filter(Boolean);
        const body = raw.slice(idx + 1).trim();            // verbatim; inner ":" stays
        return { body, tags: Array.from(new Set(tags)) };
    }
    // fallback: inline sigils
    const tags: string[] = [];
    const re = /(^|[\s(])([#+])([A-Za-z][\w-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) tags.push(m[3].toLowerCase());
    // strip only +tags from the body; keep #tags inline. The preceding-char class
    // mirrors the extraction regex above so `(+tag)` is stripped too, not left behind.
    const body = raw.replace(/(^|[\s(])\+([A-Za-z][\w-]*)/g, "$1").trim();
    return { body, tags: Array.from(new Set(tags)) };
}

/* best-effort preview resolution of composer tokens into the controlled axes. It maps
   each token through the frontend taxonomy MIRROR (resolveToken), so a typed SYNONYM
   (e.g. "solved" → status:done, "bug" → type:fix) previews as its canonical chip just
   like the backend will store it. The mirror is read-only and may drift from the server
   by at most one preview chip; the server stays the source of truth. An unrecognized
   token is shown as a neutral "sin resolver" chip rather than fabricated into an axis
   (the backend accepts only the LAST unknown token as a free area). Order matches
   tagsToChips. */
export function tokensToChips(tokens: string[]): CardChip[] {
    let type = "", status = "", priority = "", horizon = "", effort = "";
    const areas: string[] = [];
    const unresolved: string[] = [];
    tokens.forEach((tok, i) => {
        const m = resolveToken(tok);
        if (!m) {
            // the backend accepts the LAST unknown token as a free-text area value;
            // preview it that way so the chip matches what gets stored.
            if (i === tokens.length - 1) areas.push(tok); else unresolved.push(tok);
            return;
        }
        switch (m.axis) {
            case "type": type ? unresolved.push(tok) : (type = m.canonical); break;
            case "status": status ? unresolved.push(tok) : (status = m.canonical); break;
            case "priority": priority ? unresolved.push(tok) : (priority = m.canonical); break;
            case "horizon": horizon ? unresolved.push(tok) : (horizon = m.canonical); break;
            case "effort": effort ? unresolved.push(tok) : (effort = m.canonical); break;
            case "area": areas.push(m.canonical); break;
        }
    });
    const chips: CardChip[] = [];
    if (type) chips.push({ label: type, color: typeColor(type), axis: "type" });
    if (status) chips.push({ label: status, color: STATUS_COLOR[status] ?? NEUTRAL, axis: "status" });
    if (priority) chips.push({ label: priority, color: PRIORITY_COLOR[priority] ?? NEUTRAL, axis: "priority" });
    if (horizon && horizon !== "now") chips.push({ label: horizon, color: HORIZON_COLOR[horizon] ?? NEUTRAL, axis: "horizon" });
    areas.forEach((a) => chips.push({ label: a, color: AREA_COLOR, axis: "area" }));
    if (effort) chips.push({ label: effort, color: EFFORT_COLOR, axis: "effort" });
    // unresolved tokens (synonyms the server will canonicalize, or genuine conflicts)
    // are shown neutral, marked so hovering explains they resolve server-side.
    unresolved.forEach((u) => chips.push({ label: u, color: NEUTRAL, axis: "sin resolver" }));
    return chips;
}

/* adapt a LinkTarget into the minimal CardVM buildCardRef needs (refKind/shortId/body),
   so the composer can show the "replying to #…" header above the live preview. */
export function linkTargetVM(link: LinkTarget): CardVM {
    return {
        id: link.id,
        shortId: link.shortId,
        created: 0,
        body: link.body,
        chips: [],
        railColor: NEUTRAL,
        refId: null,
        refKind: link.kind,
        backlinks: [],
        children: [],
    };
}

/* an ephemeral CardVM for the composer's live preview — no real BCard behind it. The
   rail color follows the same rule the backend will apply (future horizon → violet,
   else type). */
export function previewVM(body: string, tokens: string[], link?: LinkTarget | null): CardVM {
    const chips = tokensToChips(tokens);
    // resolve through the taxonomy mirror so synonyms drive the rail color too
    // ("future"/"futuro" → violet, "bug" → fix orange, etc.).
    const resolved = tokens.map((t) => resolveToken(t));
    const hasFuture = resolved.some((m) => m?.axis === "horizon" && m.canonical === "future");
    const typeTok = resolved.find((m) => m?.axis === "type")?.canonical ?? "note";
    return {
        id: "preview",
        shortId: "····",
        created: Date.now(),
        body,
        chips,
        railColor: hasFuture ? HORIZON_COLOR.future : typeColor(typeTok),
        refId: link ? link.id : null,
        refKind: link ? link.kind : "",
        backlinks: [],
        children: [],
    };
}
