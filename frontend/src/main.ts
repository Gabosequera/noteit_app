import "./style.css";
import { Cmdline } from "./cmdline.js";
import { NoteService, Note, NewNote, Anchor, CardService, CardFilter, NewCard } from "../bindings/github.com/Gabosequera/noteit_app/index.js";
import { NoteEditor, type VimMode } from "./editor/noteEditor.js";
import { tagColor, type ParsedStatement } from "./statement.js";
import { mapCard, type CardVM } from "./cards/cardData.js";
import { renderTimeline, buildCardEl } from "./cards/cardView.js";
import { renderCardFocus } from "./cards/cardFocus.js";
import { cardEmbeds, refreshEmbeds, insertEmbed, type EmbedSpec } from "./editor/cardEmbed.js";
import { HelpPage } from "./help.js";
import {
    CommandRegistry,
    InputDispatcher,
    Keymap,
    DEFAULT_KEYMAP,
    parseChord,
    SIDEBAR,
    DOCUMENT,
    COMPOSE,
    LEADER,
    SCOPE_LEFT,
    SCOPE_RIGHT,
    type Scope,
    type Binding,
} from "./input/index.js";

console.log("%cnoteit", "color:#ff9f45;font-weight:700;font-size:16px");
console.log("frontend booted — wails v3 + vanilla ts · liquid-glass layout");

/* ───────────────────────── Note view-model (live data from Go) ───────────────── */
interface DeckAnchor { file: string; lines: string; commit: string; }
interface DeckNote {
    id: string; when: string; whenShort: string; who: string; title: string; color: string; status: string; body: string;
    tags: string[]; priority: string; branch: string; people: string[]; anchors: DeckAnchor[];
}

const STATUS_COLOR: Record<string, string> = {
    todo: "#6b7686", working: "#e3b341", blocked: "#f85149", done: "#5ef3a8"
};

let NOTES: DeckNote[] = [];

/* ───────────────────────── v3 cards (the PRIMARY surface) ─────────────────────────
   Cards are the immutable, append-only timeline (CardService). Notes/docs are the
   secondary text surface (NoteService). `view` decides which the detail pane shows;
   it defaults to the card timeline. */
let CARDS: CardVM[] = [];
let cursorCardId: string | null = null;             // cursored card in the timeline
let focusCard: CardVM | null = null;                // the card the focus view is reading (GetCard result)
let focusReq = 0;                                   // monotonic token: only the latest GetCard may commit
let view: "timeline" | "doc" | "card" = "timeline"; // primary = the card timeline; "card" = focus/thread

function fmtWhen(iso: unknown): string {
    if (!iso) return "";
    const d = new Date(iso as string);
    if (isNaN(d.getTime())) return String(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtShort(iso: unknown): string {
    if (!iso) return "";
    const d = new Date(iso as string);
    if (isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function mapNote(n: Note): DeckNote {
    return {
        id: n.id,
        when: fmtWhen(n.created),
        whenShort: fmtShort(n.created),
        who: "local",
        title: n.title || "untitled",
        color: STATUS_COLOR[n.status] ?? STATUS_COLOR.todo,
        status: n.status ?? "todo",
        body: n.body ?? "",
        tags: n.tags ?? [],
        priority: n.priority ?? "",
        branch: n.branch ?? "",
        people: n.people ?? [],
        anchors: (n.anchors ?? []).map((a) => ({ file: a.file, lines: a.lines, commit: a.commit }))
    };
}

/* ───────────────────────── DOM handles ───────────────────────── */
const sidebar = document.getElementById("sidebar")!;
const sidebarBody = document.getElementById("sidebarBody")!;
const detailScroll = document.getElementById("detailScroll")!;
const folderName = document.getElementById("folderName")!;
const folderSwitch = document.getElementById("folderSwitch")!;
const addBtn = document.getElementById("addBtn")!;
const cmdbar = document.getElementById("cmdbar")!;
const cmdField = document.getElementById("cmdField")!;
const cmdInput = document.getElementById("cmdInput") as HTMLInputElement;
const modeEl = document.getElementById("mode")!;
const stMsg = document.getElementById("stMsg")!;
const barCaret = document.getElementById("barCaret")!;
const barMirror = document.getElementById("barMirror")!;
/* lualine-style statusline segments. */
const slBranch = document.getElementById("slBranch")!;
const slBranchTxt = document.getElementById("slBranchTxt")!;
const slFolder = document.getElementById("slFolder")!;
const slFile = document.getElementById("slFile")!;
const slPos = document.getElementById("slPos")!;
const toastEl = document.getElementById("toast")!;

let active = 0;                                   // index into visibleNotes()
let viewMode: "folder" | "tree" = "folder";
let tagFilter: string | null = null;             // when set, list is filtered to a tag/"folder"
let baseFolder = "devlog";

/* ───────────────────────── Cursor scope state ─────────────────────────
   The keyboard model is vscode/nvim-style: the app tracks which *scope* the
   cursor lives in (sidebar list, document body, or the compose box), plus the
   cursor position within the document. Keys are mapped to abstract commands by
   the Keymap; the command implementations below read/mutate this state. */
let scope: Scope = COMPOSE;       // focused pane; COMPOSE = bottom composer
let prevScope: Scope = DOCUMENT;  // scope to restore from a transient LEADER
let leaderActive = false;                    // true while a leader key sequence is being captured
let leaderSeq: string[] = [];                // chords pressed after the leader key (shown in the statusline)
let statusTimer: number | undefined;         // clears a transient showcmd notice

/* ───────────────────────── CodeMirror editor (the text engine) ─────────────────────────
   The note body is plain markdown edited directly in a single CodeMirror+vim
   buffer (the "Obsidian model"): real vim motions, a block cursor, and
   virtualized rendering that stays fast on long documents. The editor host is
   mounted ONCE and persists across note switches (we only call editor.setDoc);
   the head/title/meta around it are cheap to rebuild. */
let editor: NoteEditor | null = null;        // the one persistent editor instance
let timelineHost: HTMLElement | null = null; // mount point for the card timeline (primary view)
let focusHost: HTMLElement | null = null;    // mount point for the card focus/thread view
let editorHost: HTMLElement | null = null;   // stable mount point inside the detail pane
let detailHead: HTMLElement | null = null;   // rebuilt-per-note header above the editor
let detailEmpty: HTMLElement | null = null;  // empty-state node (shown when no notes exist)
let editorNoteId: string | null = null;      // id of the note currently loaded in the editor
let vimMode: VimMode = "normal";             // last vim mode reported by the editor
let bodyTimer: number | undefined;           // debounce handle for whole-body autosave
let bodySaveReq = 0;                         // monotonic token: only the newest body save commits
let pendingBody: string | null = null;       // latest unsaved body text (null = nothing pending)

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* bodyPreview builds the one-line sidebar snippet: collapse the body to a single
   line and strip markdown punctuation so the list shows readable text. */
function bodyPreview(body: string): string {
    return (body ?? "")
        .split("\n")
        .join(" ")
        .replace(/[#>*`\-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
}

/* ───────────────────────── Derived data ───────────────────────── */
function visibleNotes(): DeckNote[] {
    if (tagFilter) return NOTES.filter((n) => n.tags.includes(tagFilter!));
    return NOTES;
}
function allTags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    NOTES.forEach((n) => n.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    return Array.from(m, ([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

/* ───────────────────────── Detail panel (active note) ───────────────────────── */
function anchorsBlock(n: DeckNote) {
    if (!n.anchors.length) return "";
    const items = n.anchors.map((a) =>
        `<li class="anchor"><span class="anchor-mark">⚓</span><span class="anchor-loc">${escHtml(a.file)}:${escHtml(a.lines)}</span>${a.commit ? `<span class="anchor-commit">@${escHtml(a.commit)}</span>` : ""}</li>`
    ).join("");
    return `<ul class="anchors">${items}</ul>`;
}
function metaBlock(n: DeckNote) {
    const chips: string[] = [];
    if (n.priority) chips.push(`<span class="chip chip-prio chip-prio-${n.priority}">${escHtml(n.priority)}</span>`);
    if (n.branch) chips.push(`<span class="chip chip-branch">⎇ ${escHtml(n.branch)}</span>`);
    n.people.forEach((p) => chips.push(`<span class="chip chip-person">@${escHtml(p)}</span>`));
    n.tags.forEach((t) => {
        const col = tagColor(t);
        chips.push(`<span class="chip chip-tag" title="+${escHtml(t)}" style="color:${col};border-color:${col}55">${escHtml(t)}</span>`);
    });
    return chips.length ? `<div class="chips">${chips.join("")}</div>` : "";
}
/* ───────────────────────── Editor mount + body persistence ─────────────────────────
   The detail pane hosts ONE CodeMirror editor that lives for the whole session.
   `ensureEditor` builds the persistent structure (a rebuilt-per-note header, the
   editor host, and an empty-state node) and instantiates the editor a single
   time. Note switches only swap the buffer (editor.setDoc) — we never tear the
   view down, which keeps switching cheap and the scroll virtualization warm. */
/* ───────────────────────── Card timeline (primary surface) ─────────────────────────
   The timeline mounts ONCE into the detail pane and persists; loadCards refreshes
   the data and renderCardTimeline repaints it. applyView toggles whether the detail
   pane shows the timeline (cards) or the note editor (doc/text). */
function ensureTimelineHost() {
    if (timelineHost) return;
    timelineHost = document.createElement("div");
    timelineHost.className = "timeline-host";
    detailScroll.prepend(timelineHost);
}

function renderCardTimeline() {
    ensureTimelineHost();
    if (cursorCardId && !CARDS.some((c) => c.id === cursorCardId)) cursorCardId = null;
    if (!cursorCardId && CARDS.length) cursorCardId = CARDS[CARDS.length - 1].id;
    renderTimeline(timelineHost!, CARDS, {
        cursorId: cursorCardId,
        onSetCursor: (id) => { if (!CARDS.some((c) => c.id === id)) return; cursorCardId = id; paintCardCursor(); paintStatusSegments(); },
        handlers: {
            onClick: (vm) => { cursorCardId = vm.id; paintCardCursor(); paintStatusSegments(); },
            onLink: (vm) => openLinkComposer(vm),
            onOpenRef: (id) => {
                if (!CARDS.some((c) => c.id === id)) { notify(`tarjeta #${id.replace(/-/g, "").slice(0, 4)} fuera de la vista`); return; }
                cursorCardId = id; paintCardCursor(); scrollCursorIntoView(); paintStatusSegments();
            },
        },
    });
    paintStatusSegments();
}

/* repaint just the cursor highlight without a full timeline rebuild. */
function paintCardCursor() {
    if (!timelineHost) return;
    timelineHost.querySelectorAll(".tl-node.is-cursor, .card.is-cursor").forEach((el) => el.classList.remove("is-cursor"));
    if (!cursorCardId) return;
    const node = timelineHost.querySelector(`.tl-node [data-id="${cssEsc(cursorCardId)}"]`)?.closest(".tl-node") as HTMLElement | null;
    if (node) {
        node.classList.add("is-cursor");
        node.querySelector(".card")?.classList.add("is-cursor");
    }
}
function scrollCursorIntoView() {
    if (!timelineHost || !cursorCardId) return;
    const card = timelineHost.querySelector(`.card[data-id="${cssEsc(cursorCardId)}"]`) as HTMLElement | null;
    card?.scrollIntoView({ block: "nearest" });
}
function cssEsc(s: string): string {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/* ───────────────────────── Card focus / thread view (GetCard) ─────────────────────────
   A single card read large, with its derived relations (backlinks = incoming kind=link,
   children = incoming kind=parent). The focus host mounts ONCE and persists; openCardFocus
   fetches the card (relations are server-derived), and renderCardFocusView paints it. */
function ensureFocusHost() {
    if (focusHost) return;
    focusHost = document.createElement("div");
    focusHost.className = "focus-host";
    detailScroll.prepend(focusHost);
}

/* resolve relation ids against the loaded set, counting (not hiding) any that aren't
   present so the view can be honest about a partial picture. */
function resolveCards(ids: string[], byId: Map<string, CardVM>): { found: CardVM[]; missing: number } {
    const found: CardVM[] = [];
    let missing = 0;
    for (const id of ids) {
        const c = byId.get(id);
        if (c) found.push(c); else missing++;
    }
    return { found, missing };
}

/* enter the focus view for a card: fetch it (with server-derived relations), park the
   cursor on it (so leaving lands there), and switch the detail pane to the thread. */
async function openCardFocus(id: string) {
    const req = ++focusReq;                          // claim the latest-fetch slot
    let card;
    try {
        card = await CardService.GetCard(id);
    } catch (err) {
        if (req === focusReq) {                       // only the latest fetch may report
            console.error("GetCard failed", err);
            notify("no se pudo abrir la tarjeta");
        }
        return;
    }
    if (req !== focusReq) return;                     // a newer open/back superseded us
    focusCard = mapCard(card);
    cursorCardId = id;
    setSurface("card");
}

function renderCardFocusView() {
    ensureFocusHost();
    if (!focusCard) { backToTimeline(); return; }
    const byId = new Map(CARDS.map((c) => [c.id, c]));
    const refTarget = focusCard.refId ? byId.get(focusCard.refId) ?? null : null;
    const children = resolveCards(focusCard.children, byId);
    const backlinks = resolveCards(focusCard.backlinks, byId);
    renderCardFocus(focusHost!, {
        card: focusCard,
        refTarget,
        children: children.found,
        backlinks: backlinks.found,
        missing: children.missing + backlinks.missing,
    }, {
        onBack: () => backToTimeline(),
        onOpenCard: (rid) => { void openCardFocus(rid); },
        onLink: (vm) => openLinkComposer(vm),
    });
    paintStatusSegments();
}

/* leave the focus view, returning to the timeline with the read card under the cursor. */
function backToTimeline() {
    setSurface("timeline");
    paintCardCursor();
    scrollCursorIntoView();
}

/* ───────────────────────── Doc surface (text notes that embed cards) ─────────────────────────
   The note editor is the SECONDARY surface: plain markdown that can embed immutable
   cards via `!card[uuid]` lines. Entering hands the keyboard to vim; leaving blurs
   the editor (so structural app keys work again) and flushes any pending body save.

   blurEditorAndFlush is the single, explicit "step out of the editor" primitive used
   by every doc→elsewhere transition (mirrors the blur+flush setScope does, but usable
   on its own from a vim ex-command where the scope machine isn't the trigger). */
function blurEditorAndFlush() {
    if (editor && editor.view.hasFocus) editor.view.contentDOM.blur();
    void flushBodySave();
}

/* open the note at sidebar index `i` as the doc surface and focus the editor. Note
   bodies are already in memory (loadNotes), so this is synchronous — no load race. */
function openDoc(i: number) {
    active = i;
    setSurface("doc");      // applyView → renderDetail loads the body into the editor
    renderSidebar();        // repaint with view=doc so the note (not the timeline row) is active
    setScope(DOCUMENT);     // hand the keyboard to CodeMirror + vim
}

/* open the currently-active note as a doc (used by the `:doc` palette command, which
   can fire from the timeline where there is no sidebar click). */
function openActiveDoc() {
    if (visibleNotes().length === 0) { notify("no hay notas para abrir"); return; }
    openDoc(active);
}

/* leave the doc surface back to the card timeline (the `:timeline` vim ex-command). */
function exitDocToTimeline() {
    blurEditorAndFlush();
    setSurface("timeline");
    paintCardCursor();
    scrollCursorIntoView();
}

/* insert the cursored card as an embed at the editor caret (the `:embed` vim
   ex-command). The card last cursored in the timeline is the one embedded; resolution
   to DOM happens lazily through the EmbedSpec, so we only need its id here. */
function embedCard() {
    if (view !== "doc" || !editor) { notify("abrí una nota para insertar una tarjeta"); return; }
    const vm = cursorCardId ? CARDS.find((c) => c.id === cursorCardId) ?? null : null;
    if (!vm) { notify("seleccioná una tarjeta en la línea de tiempo para insertarla"); return; }
    insertEmbed(editor.view, vm.id);
    notify(`tarjeta #${vm.shortId} insertada`);
}

/* an embed's flag (or its ref preview) was clicked: leave the editor cleanly and open
   the card's thread. */
function openCardFromEmbed(id: string) {
    blurEditorAndFlush();
    void openCardFocus(id);
}

/* the small link arrow used on the embed flag, built namespaced so it renders as a
   real SVG (and avoids any innerHTML in the embed path). */
function linkGlyph(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1");
    svg.appendChild(path);
    return svg;
}

/* EmbedSpec: the app half of the editor's card embeds. The editor module locates
   `!card[uuid]` lines; this resolves each id against the live CARDS and builds the
   read-only DOM (or a tombstone when the card is gone — cards are append-only, so a
   missing id means it was never created, not deleted). */
function buildEmbedSpec(): EmbedSpec {
    return {
        render(id: string): HTMLElement {
            const byId = new Map(CARDS.map((c) => [c.id, c]));
            const vm = byId.get(id) ?? null;
            if (!vm) {
                const miss = document.createElement("div");
                miss.className = "embed embed-missing";
                miss.textContent = `tarjeta no encontrada · #${id.slice(0, 8)}`;
                return miss;
            }
            const wrap = document.createElement("div");
            wrap.className = "embed";

            // Build the flag with DOM APIs (no innerHTML) so the card-derived shortId is
            // never interpolated into a markup string — text goes in as a text node.
            const flag = document.createElement("button");
            flag.className = "embed-flag";
            flag.type = "button";
            flag.appendChild(linkGlyph());
            flag.appendChild(document.createTextNode(`tarjeta · #${vm.shortId}`));
            flag.addEventListener("click", () => openCardFromEmbed(vm.id));
            wrap.appendChild(flag);

            const refTarget = vm.refId ? byId.get(vm.refId) ?? null : null;
            wrap.appendChild(buildCardEl(vm, {
                mode: "embed",
                refTarget,
                handlers: { onOpenRef: openCardFromEmbed },
            }));
            return wrap;
        },
    };
}

/* re-fetch + repaint the focus view if it is open (e.g. after a new link/child was
   minted), so freshly-created relations appear without leaving the thread. */
async function refreshFocusIfOpen() {
    if (view !== "card" || !focusCard) return;
    await openCardFocus(focusCard.id);
}

/* setSurface is the SINGLE gate for changing the active detail-pane surface
   (timeline / card / doc). Leaving the focus view (card → anything else)
   invalidates any in-flight GetCard via focusReq and drops focusCard, so a late
   fetch can never resurrect a stale thread — the race guard lives here once
   instead of in every caller. (Distinct from the legacy sidebar-mode `setView`.) */
function setSurface(next: "timeline" | "doc" | "card") {
    if (view === "card" && next !== "card") {
        focusReq++;            // a superseded fetch must not commit after we leave
        focusCard = null;
    }
    view = next;
    applyView();
}

/* applyView shows ONE of three surfaces in the detail pane: the card timeline
   (primary), the card focus/thread view, or the note editor (doc/text). The two card
   surfaces hide the editor structure outright; doc mode lets renderDetail() own the
   head/host/empty visibility (so it can restore them from the note list state). */
function applyView() {
    ensureTimelineHost();
    ensureFocusHost();
    const isTimeline = view === "timeline";
    const isCard = view === "card";
    const isDoc = view === "doc";
    timelineHost!.hidden = !isTimeline;
    focusHost!.hidden = !isCard;
    detailScroll.classList.toggle("view-timeline", isTimeline);
    detailScroll.classList.toggle("view-card", isCard);
    detailScroll.classList.toggle("view-doc", isDoc);
    detailScroll.classList.toggle("has-editor", isDoc);   // editor layout is doc-only
    if (isDoc) {
        renderDetail();   // owns head/host/empty visibility from the note list
        return;
    }
    // both card surfaces share a clean slate (no editor chrome)
    if (detailHead) detailHead.hidden = true;
    if (editorHost) editorHost.hidden = true;
    if (detailEmpty) detailEmpty.hidden = true;
    if (isTimeline) renderCardTimeline();
    else renderCardFocusView();
}

async function loadCards() {
    try {
        const list = await CardService.ListCards(new CardFilter());
        CARDS = (list ?? []).map(mapCard);
        renderSidebar();  // keep the pinned timeline-row count in sync with the card set
        if (view === "timeline") renderCardTimeline();
        else if (view === "card") await refreshFocusIfOpen();  // re-fetch derived relations
        else if (view === "doc" && editor) refreshEmbeds(editor.view);  // re-resolve embeds
    } catch (err) {
        console.error("ListCards failed", err);
        CARDS = [];
        if (view === "timeline") renderCardTimeline();
        else if (view === "card") renderCardFocusView();   // drop stale relations honestly
        else if (view === "doc" && editor) refreshEmbeds(editor.view);  // repaint as tombstones
        notify("backend de tarjetas no disponible");
    }
}

/* mint a card via CardService, then reload + park the cursor on the new card. Cards
   are immutable/append-only, so create is the only write. */
async function createCard(body: string, tags: string[], linkId: string | null, linkKind: "" | "link" | "parent") {
    try {
        const input = NewCard.createFrom({
            body,
            tags,
            refId: linkId ?? "",
            refKind: linkId ? (linkKind || "link") : "",
        });
        const created = await CardService.CreateCard(input);
        await loadCards();   // reloads CARDS; if a thread is open, refreshes its relations too
        if (view !== "card" && created?.id) {
            cursorCardId = created.id;
            if (view === "timeline") { paintCardCursor(); scrollCursorIntoView(); paintStatusSegments(); }
        }
        notify(linkId ? `tarjeta enlazada · #${created?.id ? created.id.replace(/-/g, "").slice(0, 4) : "?"}` : "tarjeta creada");
    } catch (err) {
        console.error("CreateCard failed", err);
        notify("no se pudo crear la tarjeta");
    }
}

/* open the composer linked to a card (the cursor card by default). kind=link is a
   sibling reply; kind=parent nests the new card under the target. */
function openLinkComposer(target?: CardVM, kind: "link" | "parent" = "link") {
    const vm = target ?? CARDS.find((c) => c.id === cursorCardId) ?? null;
    if (!vm) { notify("no hay tarjeta seleccionada"); return; }
    cmdline.show({ intent: "card", linkTarget: { id: vm.id, shortId: vm.shortId, body: vm.body, kind } });
}

function jumpCardCursor(where: "top" | "bottom") {
    if (CARDS.length === 0) return;
    cursorCardId = where === "top" ? CARDS[0].id : CARDS[CARDS.length - 1].id;
    paintCardCursor();
    scrollCursorIntoView();
    paintStatusSegments();
}

function moveCardCursor(delta: number) {
    if (CARDS.length === 0) return;
    let idx = CARDS.findIndex((c) => c.id === cursorCardId);
    if (idx < 0) idx = CARDS.length - 1;
    idx = Math.min(CARDS.length - 1, Math.max(0, idx + delta));
    cursorCardId = CARDS[idx].id;
    paintCardCursor();
    scrollCursorIntoView();
    paintStatusSegments();
}

function ensureEditor() {
    if (editor) return;
    detailHead = document.createElement("div");
    detailHead.className = "detail-head";
    editorHost = document.createElement("div");
    editorHost.className = "editor-host";
    detailEmpty = document.createElement("div");
    detailEmpty.className = "detail-empty";
    detailEmpty.innerHTML = `<p>aún no hay notas — pulsá <kbd>i</kbd> para crear una</p>`;
    detailScroll.classList.add("has-editor");
    detailScroll.append(detailHead, editorHost, detailEmpty);
    editor = new NoteEditor({
        parent: editorHost,
        doc: "",
        onChange: (doc) => scheduleBodySave(doc),
        onModeChange: (m) => onVimMode(m),
        onCursorChange: (line, col) => { slPos.textContent = `${line}:${col}`; },
        // Render `!card[uuid]` lines as read-only card embeds inside the live buffer.
        extensions: [cardEmbeds(buildEmbedSpec())],
        // vim owns `:` in the editor, so structural triggers that must fire from INSIDE
        // the editor are ex-commands: `:embed` drops the cursored card, `:timeline`
        // steps back out to the card timeline.
        exCommands: [
            { name: "embed", prefix: "emb", run: embedCard },
            { name: "timeline", prefix: "time", run: exitDocToTimeline },
        ],
    });
}

/* Map the editor's vim mode onto the statusline + a CSS state. While the document
   scope owns the bar, the mode segment mirrors the live vim mode (NORMAL/INSERT/…)
   exactly like nvim's modeline. */
function vimModeLabel(m: VimMode): string {
    switch (m) {
        case "insert": return "INSERT";
        case "visual": return "VISUAL";
        case "visual-line": return "V·LINE";
        case "visual-block": return "V·BLOCK";
        case "replace": return "REPLACE";
        default: return "NORMAL";
    }
}

/* paintMode drives the lualine mode segment: the label text plus a `data-mode`
   attribute that the CSS maps to a per-mode color (blue normal, green insert,
   amber visual, red replace, …). The `.normal` class on the bar is kept only to
   drive the composer's block caret (it shows when not actively typing). */
function paintMode(label: string, kind: string) {
    modeEl.textContent = label;
    modeEl.dataset.mode = kind;
}
function onVimMode(m: VimMode) {
    vimMode = m;
    // Only repaint the bar when the editor actually owns it (document scope, no
    // pending leader). In other scopes the mode segment shows that scope's label.
    const cur = scope === LEADER ? prevScope : scope;
    if (cur === DOCUMENT) {
        paintMode(vimModeLabel(m), m);
        cmdbar.classList.toggle("normal", m !== "insert");
    }
}

/* renderDetail repaints the per-note header and loads the active note's raw
   markdown body into the persistent editor. It NEVER rebuilds the editor host —
   only the cheap header — so the CodeMirror view (and its scroll position /
   undo history) survives header re-renders. The body is swapped only when the
   active note id actually changes, so a sidebar re-render mid-typing can't clobber
   un-saved keystrokes with the last-loaded body. */
function renderDetail() {
    ensureEditor();
    paintStatusSegments();
    const head = detailHead!, host = editorHost!, empty = detailEmpty!;

    const list = visibleNotes();
    if (list.length === 0) {
        // No notes: park the editor (blank, hidden) and show the empty state.
        if (editorNoteId !== null) { editor!.setDoc(""); editorNoteId = null; }
        head.hidden = true;
        host.hidden = true;
        empty.hidden = false;
        return;
    }
    if (active >= list.length) active = list.length - 1;
    if (active < 0) active = 0;
    const n = list[active];

    empty.hidden = true;
    head.hidden = false;
    host.hidden = false;

    head.innerHTML =
        `<div class="dn-head">
            <span class="when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
            <span class="who">${escHtml(n.who)}</span>
        </div>
        <h1 class="dn-title"><span class="hash">#</span>${escHtml(n.title)}</h1>
        ${metaBlock(n)}
        ${anchorsBlock(n)}`;

    // Swap the buffer only on a real note change. setDoc suppresses onChange, so
    // this never triggers a spurious save; flush any pending save for the note we
    // are leaving first so its last edits aren't dropped.
    if (editorNoteId !== n.id) {
        if (editorNoteId !== null) void flushBodySave();
        editor!.setDoc(n.body);
        editorNoteId = n.id;
        editor!.view.scrollDOM.scrollTop = 0;
    }
}

/* ───────────────────────── Whole-body autosave (editor → SaveBody) ─────────────────────────
   The editor edits the note's raw markdown directly, so persistence is a single
   debounced whole-body write (SaveBody) — no block diffing, no journal entry.
   Saves are tagged to the note that was open when the keystroke landed, so a save
   that resolves after the user switched notes never writes to the wrong file. */
function scheduleBodySave(body: string) {
    pendingBody = body;
    clearTimeout(bodyTimer);
    bodyTimer = window.setTimeout(() => { void flushBodySave(); }, 600);
}

async function flushBodySave() {
    clearTimeout(bodyTimer);
    if (pendingBody === null || editorNoteId === null) return;
    const id = editorNoteId;
    const body = pendingBody;
    pendingBody = null;
    const token = ++bodySaveReq;
    try {
        const note = await NoteService.SaveBody(id, body);
        if (token !== bodySaveReq) return;   // a newer save superseded this one
        // Keep the in-memory note + sidebar preview fresh without disturbing the
        // editor (which already holds the authoritative live text).
        const idx = NOTES.findIndex((nn) => nn.id === id);
        if (idx >= 0) {
            NOTES[idx].body = note.body ?? body;
            renderSidebar();
        }
    } catch (err) {
        console.error("SaveBody failed", err);
        notify("no se pudo guardar el cuerpo de la nota");
    }
}

/* ───────────────────────── Sidebar (note list / tree) ───────────────────────── */
/* A single clickable "timeline" entry pinned at the top of the sidebar. Clicking it
   opens the WHOLE card timeline in the detail pane — it does NOT expand the cards into
   the sidebar (that noise is exactly what the user did not want). It is highlighted
   while a card surface (timeline/focus) is the active view. */
function appendTimelineRow() {
    const el = document.createElement("div");
    el.className = "tl-link" + (view === "timeline" || view === "card" ? " is-active" : "");
    el.innerHTML =
        `<svg class="tl-link-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
         <span class="tl-link-name">timeline</span>
         <span class="tl-link-count">${CARDS.length}</span>`;
    el.addEventListener("click", () => openTimelineSurface());
    sidebarBody.appendChild(el);
}

/* Switch the detail pane to the card timeline from a sidebar click: step out of the
   editor cleanly (flush + blur), show the timeline, and repaint the sidebar so the
   timeline row / active note highlight track the new surface. */
function openTimelineSurface() {
    blurEditorAndFlush();
    setSurface("timeline");
    renderSidebar();
    paintCardCursor();
    scrollCursorIntoView();
}

function renderSidebar() {
    sidebar.classList.toggle("tree-mode", viewMode === "tree");
    folderName.textContent = viewMode === "tree" ? "notes" : (tagFilter ?? baseFolder);
    sidebarBody.innerHTML = "";

    if (viewMode === "tree") { appendTimelineRow(); renderTree(); return; }

    appendTimelineRow();

    const list = visibleNotes();
    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty";
        empty.innerHTML = `Carpeta vacía.<br/>Pulsá <kbd>+</kbd> o <kbd>i</kbd> para una nota nueva.`;
        sidebarBody.appendChild(empty);
        return;
    }
    if (active >= list.length) active = list.length - 1;
    if (active < 0) active = 0;

    list.forEach((n, i) => {
        const el = document.createElement("div");
        // A note is highlighted only while it is the open doc surface — on the card
        // timeline the timeline row owns the highlight instead.
        el.className = "note-item" + (i === active && view === "doc" ? " is-active" : "");
        const preview = bodyPreview(n.body);
        const tags = n.tags.slice(0, 3).map((t) => `<span class="ni-tag" style="--c:${tagColor(t)}">${escHtml(t)}</span>`).join("");
        el.innerHTML =
            `<div class="ni-top">
                <span class="ni-dot" style="--c:${n.color}"></span>
                <span class="ni-title">${escHtml(n.title)}</span>
                <span class="ni-when">${escHtml(n.whenShort)}</span>
            </div>
            ${preview ? `<div class="ni-sub">${escHtml(preview)}</div>` : ""}
            ${tags ? `<div class="ni-tags">${tags}</div>` : ""}`;
        // Clicking a note opens it as the doc surface and focuses the editor (openDoc
        // owns the render + surface + scope switch, so the embed-capable editor is
        // shown rather than left hidden behind the card timeline).
        el.addEventListener("click", () => openDoc(i));
        sidebarBody.appendChild(el);
    });
    // The active note is offset by the pinned timeline row (child 0), so scroll the
    // matching .note-item rather than indexing sidebarBody.children directly.
    if (view === "doc") {
        sidebarBody.querySelectorAll(".note-item")[active]?.scrollIntoView({ block: "nearest" });
    }
}

function renderTree() {
    const folders = allTags();
    const head = document.createElement("div");
    head.className = "tree-row is-folder";
    head.dataset.depth = "0";
    head.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${escHtml(baseFolder)}</span><span class="tr-count">${NOTES.length}</span>`;
    head.addEventListener("click", () => { tagFilter = null; viewMode = "folder"; active = 0; renderSidebar(); renderDetail(); });
    sidebarBody.appendChild(head);

    if (folders.length === 0) {
        const note = document.createElement("div");
        note.className = "sidebar-empty";
        note.innerHTML = "Sin sub-carpetas (tags) todavía.";
        sidebarBody.appendChild(note);
        return;
    }
    folders.forEach(({ tag, count }) => {
        const el = document.createElement("div");
        el.className = "tree-row";
        el.dataset.depth = "1";
        el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span style="color:${tagColor(tag)}">${escHtml(tag)}</span><span class="tr-count">${count}</span>`;
        el.addEventListener("click", () => { tagFilter = tag; viewMode = "folder"; active = 0; renderSidebar(); renderDetail(); });
        sidebarBody.appendChild(el);
    });
}

/* Re-render both panes. applyView owns the detail pane for ALL views (timeline /
   card / doc), so there is a single place that decides which surface shows. */
function render() {
    renderSidebar();
    applyView();
}

function move(delta: number) {
    const list = visibleNotes();
    if (list.length === 0) return;
    active = (active + delta + list.length) % list.length;
    render();
}

/* ───────────────────────── Backend wiring (storage) ───────────────────────── */
let creating = false;

async function loadNotes() {
    try {
        const list = await NoteService.ListNotes();
        NOTES = (list ?? []).map(mapNote);
        const vis = visibleNotes();
        if (active >= vis.length) active = Math.max(0, vis.length - 1);
        render();
    } catch (err) {
        console.error("ListNotes failed", err);
        NOTES = [];
        render();
        notify("backend no disponible (¿modo navegador?)");
    }
}

async function createNoteFromInput() {
    const title = cmdInput.value.split("\n")[0].trim();
    if (!title || creating) return;
    creating = true;
    try {
        await NoteService.CreateNote(title, "");
        cmdInput.value = "";
        updateBarCaret();
        tagFilter = null;
        await loadNotes();
        active = 0;
        render();
        notify("✓ note created");
    } catch (err) {
        console.error("CreateNote failed", err);
        notify("error al crear la nota");
    } finally {
        creating = false;
    }
}

async function createNoteFromStatement(st: ParsedStatement) {
    if (creating) return;
    creating = true;
    try {
        const input = NewNote.createFrom({
            title: st.title,
            body: st.body,
            tags: st.tags,
            status: st.status,
            priority: st.priority,
            people: st.people,
            anchors: st.anchors.map((a) => Anchor.createFrom({ file: a.file, lines: a.lines, commit: "" }))
        });
        await NoteService.CreateNoteFull(input);
        tagFilter = null;
        await loadNotes();
        active = 0;
        render();
        const extras = [
            st.tags.length ? `${st.tags.length} tag(s)` : "",
            st.anchors.length ? `${st.anchors.length} ancla(s)` : ""
        ].filter(Boolean).join(", ");
        notify(`✓ nota creada${extras ? " · " + extras : ""}`);
    } catch (err) {
        console.error("CreateNoteFull failed", err);
        notify("error al crear la nota (revisá estado/prioridad)");
    } finally {
        creating = false;
    }
}

async function addAnchorToActive(file: string, lines: string) {
    const list = visibleNotes();
    if (list.length === 0) { notify("no hay nota activa para anclar"); return; }
    const id = list[active].id;
    try {
        await NoteService.AddAnchor(id, file, lines);
        await loadNotes();
        render();
        notify(`⚓ ${file}:${lines}`);
    } catch (err) {
        console.error("AddAnchor failed", err);
        notify("no se pudo anclar (¿archivo/líneas válidas?)");
    }
}

/* ───────────────────────── Toast ───────────────────────── */
let toastTimer: number | undefined;
function notify(msg: string) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("visible"));
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toastEl.classList.remove("visible");
        window.setTimeout(() => (toastEl.hidden = true), 200);
    }, 2600);
}

/* ───────────────────────── Block cursor (bottom bar) ───────────────────────── */
function updateBarCaret() {
    barMirror.textContent = cmdInput.value || "";
    const w = barMirror.getBoundingClientRect().width;
    barCaret.style.left = `${w}px`;
}

/* ───────────────────────── Views / folder switch ───────────────────────── */
function setView(view: string) {
    if (view === "__insert__") { setMode("insert"); notify("✎ new note"); return; }
    if (view === "tree" || view === "projects") { viewMode = "tree"; tagFilter = null; render(); notify("→ tree"); return; }
    if (view === "notes" || view === "inbox") { viewMode = "folder"; tagFilter = null; active = 0; render(); notify("→ notes"); return; }
    if (view === "tags") { viewMode = "tree"; render(); notify("→ tags"); return; }
    notify(`→ ${view}`);
}

function toggleTree() {
    viewMode = viewMode === "tree" ? "folder" : "tree";
    if (viewMode === "folder") active = 0;
    render();
}
folderSwitch.addEventListener("click", toggleTree);
/* The "+" affordance is surface-aware: while a card surface is showing (the primary
   timeline or a focused thread) it composes a CARD; only in the secondary text/doc
   surface does it start a NOTE. This is what was trapping users into making notes
   when they meant to create a card. */
addBtn.addEventListener("click", () => { startPrimaryCompose(); });

/* The single "create" entry the UI exposes. Routes to the card composer when the
   active surface is a card surface (timeline/focus), otherwise the note composer. */
function startPrimaryCompose() {
    if (view === "timeline" || view === "card") { cmdline.show({ intent: "card" }); return; }
    setMode("insert");
    notify("✎ nueva nota");
}

const help = new HelpPage();

document.querySelectorAll<HTMLElement>(".tool").forEach((el) => {
    el.addEventListener("click", () => {
        const tool = el.dataset.tool;
        document.querySelectorAll(".tool").forEach((t) => t.classList.remove("is-active"));
        if (tool === "tree" || tool === "tags") { el.classList.add("is-active"); setView("tree"); }
        else if (tool === "search") { cmdline.show(); }
        else if (tool === "help") { help.show(); }
        else if (tool === "settings") { toggleGlass(); }
    });
});

function filterTag(tag: string) {
    const exists = NOTES.some((n) => n.tags.includes(tag));
    if (!exists) { notify(`# tag "${tag}" no existe`); return; }
    tagFilter = tag; viewMode = "folder"; active = 0; render();
    notify(`# filtrando por tag: ${tag}`);
}

/* ───────────────────────── Theme ───────────────────────── */
let light = false;
function toggleTheme() {
    light = !light;
    document.documentElement.classList.toggle("light", light);
    notify(`theme: ${light ? "light" : "dark"}`);
}

/* ───────────────────────── Liquid glass toggle (⚙) ─────────────────────────
   Default ON: real window transparency + backdrop blur. Turning it OFF paints
   an opaque diffuse gray and drops the blur, saving compositing work. Persisted. */
let glass = localStorage.getItem("noteit.glass") !== "off"; // default ON
function applyGlass() {
    document.documentElement.classList.toggle("solid", !glass);
}
function toggleGlass() {
    glass = !glass;
    localStorage.setItem("noteit.glass", glass ? "on" : "off");
    applyGlass();
    notify(glass ? "✨ liquid glass: on" : "▢ modo sólido (ahorro de recursos)");
}
applyGlass();

/* ───────────────────────── Filesystem (necesita backend Go) ───────────────── */
function runFs(op: "cd" | "e", path: string) {
    const inWails = typeof (window as unknown as { _wails?: unknown })._wails !== "undefined";
    if (!inWails) {
        notify(`:${op} ${path || "…"} — navegación de archivos: pendiente de binding Go`);
        return;
    }
    notify(`:${op} ${path} — binding Go pendiente`);
}

/* ───────────────────────── Cmdline ───────────────────────── */
const cmdline = new Cmdline({
    setView,
    jumpToNote: (n1) => {
        const list = visibleNotes();
        const idx = Math.min(Math.max(n1, 1), list.length) - 1;
        active = idx; render(); notify(`↪ note ${idx + 1}`);
    },
    noteCount: () => visibleNotes().length,
    filterTag,
    listTags: () => allTags().map((t) => t.tag),
    toggleTheme,
    notify,
    runFs,
    reloadNotes: () => { void loadNotes(); },
    addAnchor: (file, lines) => { void addAnchorToActive(file, lines); },
    createNoteFull: (st) => { void createNoteFromStatement(st); },
    listDir: (input) => NoteService.ListDir(input)
        .then((es) => es.map((e) => ({ name: e.name, isDir: e.isDir }))),
    createCard: (body, tags, linkId, linkKind) => { void createCard(body, tags, linkId, linkKind); },
    showTimeline: () => exitDocToTimeline(),
    openActiveDoc: () => openActiveDoc(),
    showHelp: () => help.show(),
});

/* ───────────────────────── Scope / cursor state machine ─────────────────────────
   Abstract, vscode/nvim-style: the app owns which scope is focused and where the
   cursor sits. Keys are MAPPED to command ids by the Keymap; the commands below
   are the only things that read or mutate scope/cursor. Adding a binding later is
   pure config — no behavioral code changes. */

/* setScope focuses a pane. COMPOSE makes the bottom input editable+focused; nav
   scopes (SIDEBAR/DOCUMENT) blur it and become keyboard-driven; LEADER is a
   transient overlay layered on top of whatever scope was active. */
function setScope(next: Scope) {
    // Leaving the document context: blur the editor so DOM focus returns to the
    // body (otherwise the editor would keep capturing keys for vim while the
    // logical scope says SIDEBAR), and flush any pending body save so the last
    // keystrokes aren't lost across the switch. blurEditorAndFlush is the single
    // "step out of the editor" primitive — surface changes (e.g. :timeline) use it too.
    if (scope === DOCUMENT && next !== DOCUMENT && next !== LEADER) {
        blurEditorAndFlush();
    }

    if (next !== LEADER) prevScope = next;
    scope = next;

    const inCompose = next === COMPOSE;
    cmdInput.readOnly = !inCompose;
    cmdbar.classList.toggle("normal", !inCompose);
    // In the document, the mode segment mirrors the live vim mode (NORMAL/INSERT/…)
    // with its color; every other scope shows its own static label + scope color.
    if (next === DOCUMENT) paintMode(vimModeLabel(vimMode), vimMode);
    else paintMode(scopeLabel(next), next);

    // The composer field is only present while composing; otherwise the showcmd
    // area owns the row. This is what keeps the statusline thin by default.
    cmdField.hidden = !inCompose;
    stMsg.hidden = inCompose;

    if (inCompose) {
        cmdInput.focus();
    } else {
        if (document.activeElement === cmdInput) cmdInput.blur();
        updateBarCaret();
    }

    // Entering the document hands the keyboard to CodeMirror+vim: focus the editor
    // so motions/insert land in the buffer, and reflect its current vim mode badge.
    if (next === DOCUMENT) {
        editor?.focus();
        cmdbar.classList.toggle("normal", vimMode !== "insert");
    }

    if (next !== LEADER) closeLeader();

    applyScopeClasses();
    renderScopeCursor();
}

function scopeLabel(s: Scope): string {
    switch (s) {
        case COMPOSE: return "COMPOSE";
        case SIDEBAR: return "NOTES";
        case DOCUMENT: return "NORMAL";
        case LEADER: return "LEADER";
        default: return s.toUpperCase();
    }
}

/* paintStatusSegments fills the lualine context segments (branch · folder · file)
   from the active note and the current folder/tag. Hidden segments collapse, so
   a note with no git branch simply drops that segment instead of showing a gap. */
function paintStatusSegments() {
    if (view === "timeline") {
        slBranch.hidden = true;
        slFolder.textContent = "timeline";
        const cur = CARDS.find((c) => c.id === cursorCardId);
        slFile.textContent = cur ? `#${cur.shortId}` : "—";
        return;
    }
    if (view === "card") {
        slBranch.hidden = true;
        slFolder.textContent = "thread";
        slFile.textContent = focusCard ? `#${focusCard.shortId}` : "—";
        return;
    }
    const list = visibleNotes();
    const n = list[active];
    const branch = n?.branch ?? "";
    slBranch.hidden = !branch;
    if (branch) slBranchTxt.textContent = branch;
    slFolder.textContent = tagFilter ?? baseFolder;
    slFile.textContent = n?.title || "—";
}

/* Paint the focused-pane accent ring on whichever pane owns the cursor. */
function applyScopeClasses() {
    const ref = scope === LEADER ? prevScope : scope;
    sidebar.classList.toggle("scope-focus", ref === SIDEBAR);
    detailScroll.classList.toggle("scope-focus", ref === DOCUMENT);
    cmdbar.classList.toggle("scope-focus", ref === COMPOSE);
}

/* Highlight the single cursored element inside the focused nav scope. The
   document scope has no app-painted cursor — CodeMirror renders its own vim block
   cursor — so only the sidebar list gets a `.is-cursor`. */
function renderScopeCursor() {
    // scope the clear to the sidebar so the card timeline/focus cursors are never stripped
    sidebarBody.querySelectorAll(".is-cursor").forEach((el) => el.classList.remove("is-cursor"));
    const ref = scope === LEADER ? prevScope : scope;
    if (ref === SIDEBAR) {
        // The pinned timeline row is child 0; the note cursor indexes the .note-item set.
        const el = sidebarBody.querySelectorAll(".note-item")[active] as HTMLElement | undefined;
        if (el) { el.classList.add("is-cursor"); el.scrollIntoView({ block: "nearest" }); }
    }
}

/* ───────────────────────── Command implementations ───────────────────────── */

/* Vertical motion. In the sidebar this walks the note list. In the composer,
   ctrl+k climbs up into the document (the editor) — the seamless compose↔document
   edge. Inside the document, vim owns j/k, so cursorMove is never invoked there. */
function cursorMove(delta: number) {
    if (scope === SIDEBAR) { move(delta); renderScopeCursor(); return; }
    if (scope === COMPOSE && delta < 0) setScope(DOCUMENT);
}

/* Horizontal scope jump (ctrl+h / ctrl+l): move between adjacent panes per the
   SCOPE_LEFT / SCOPE_RIGHT adjacency tables. */
function scopeMove(dir: "left" | "right") {
    const table = dir === "left" ? SCOPE_LEFT : SCOPE_RIGHT;
    const target = table[scope];
    if (target) setScope(target);
}

/* Escape: collapse a transient scope back toward the document. Leader → its
   underlying scope; the composer → document. (Inside the editor, Escape is owned
   by vim — it never reaches here, so it only ever exits insert→normal.) */
function escapeScope() {
    if (scope === LEADER) { setScope(prevScope); return; }
    // Leaving the composer returns to the document (Escape never *opens* the
    // composer — like nvim, Escape only ever drops you back toward NORMAL).
    if (scope === COMPOSE) { setScope(DOCUMENT); return; }
    // Already in a nav scope: nothing to escape.
}

function focusCompose() {
    setScope(COMPOSE);
}

/* Compose submit (Enter in the composer): always bootstraps a note from the typed
   title. (Cards are no longer created here — the v3 card composer is separate.) */
function submitCompose() {
    void createNoteFromInput();
}

/* ───────────────────────── Leader (inline showcmd) ─────────────────────────
   No floating panel: leader feedback is nvim "showcmd" style — the leader symbol
   plus each chord pressed so far, painted into the statusline until the sequence
   resolves to a command (run it) or is rejected ("… no es un comando"). */
const LEADER_LABEL = "SPC";

function openLeader() {
    setScope(LEADER);
    leaderActive = true;
    leaderSeq = [];
    renderShowcmd();
}

/* Clears the pending-leader state. Invoked by setScope on every leave-LEADER
   transition (and by the sub-key commands), so the showcmd never lingers. */
function closeLeader() {
    leaderActive = false;
    leaderSeq = [];
    renderShowcmd();
}

/* renderShowcmd paints the pending leader sequence into the statusline. When no
   sequence is active it clears the area — unless a transient warning is showing,
   which showStatus owns until its timer fires. */
function renderShowcmd() {
    if (leaderActive) {
        stMsg.classList.remove("st-msg-warn");
        stMsg.classList.add("st-msg-keys");
        stMsg.textContent = [LEADER_LABEL, ...leaderSeq].join(" ");
        return;
    }
    stMsg.classList.remove("st-msg-keys");
    if (!stMsg.classList.contains("st-msg-warn")) stMsg.textContent = "";
}

/* showStatus flashes a transient nvim-style notice in the statusline (e.g.
   "SPC x no es un comando"), auto-clearing after a moment. */
function showStatus(msg: string) {
    stMsg.classList.remove("st-msg-keys");
    stMsg.classList.add("st-msg-warn");
    stMsg.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
        stMsg.classList.remove("st-msg-warn");
        if (!leaderActive) stMsg.textContent = "";
    }, 2600);
}

/* Capture one keystroke while a leader sequence is pending. Appends the chord to
   the visible sequence, then resolves it against LEADER-scoped bindings: a hit
   runs the command (which exits leader + changes scope); a miss reports it and
   returns to the underlying scope. Escape cancels. */
function handleLeaderKey(ev: KeyboardEvent) {
    if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta") return;
    const chord = parseChord(ev);
    if (chord === "escape") { escapeScope(); return; }   // cancel the sequence

    leaderSeq.push(chord);
    renderShowcmd();

    const commandId = keymap.resolve(LEADER, chord);
    if (commandId && registry.has(commandId)) {
        registry.run(commandId);   // the command closes leader + sets the next scope
        return;
    }
    // Unbound (and no deeper prefix in today's single-level keymap): report it.
    const seq = [LEADER_LABEL, ...leaderSeq].join(" ");
    escapeScope();                 // back to the underlying scope (clears the sequence)
    showStatus(`${seq} no es un comando`);
}

/* ───────────────────────── Command + Keymap + Dispatcher wiring ───────────────────────── */
const registry = new CommandRegistry();
const cmds: { id: string; title: string; run: () => void | Promise<void> }[] = [
    { id: "cursor.down", title: "Bajar cursor", run: () => cursorMove(1) },
    { id: "cursor.up", title: "Subir cursor", run: () => cursorMove(-1) },
    { id: "scope.left", title: "Scope izquierda", run: () => scopeMove("left") },
    { id: "scope.right", title: "Scope derecha", run: () => scopeMove("right") },
    { id: "scope.escape", title: "Salir del scope", run: () => escapeScope() },
    { id: "scope.focusCompose", title: "Ir al compositor", run: () => focusCompose() },
    { id: "leader.open", title: "Abrir leader", run: () => openLeader() },
    { id: "cmdline.open", title: "Línea de comandos", run: () => cmdline.show() },
    { id: "compose.submit", title: "Enviar compositor", run: () => submitCompose() },
    { id: "note.create", title: "Nueva nota", run: () => { closeLeader(); focusCompose(); } },
    { id: "card.create", title: "Nueva tarjeta", run: () => { closeLeader(); cmdline.show({ intent: "card" }); } },
    { id: "sidebar.top", title: "Inicio de la lista", run: () => { active = 0; render(); renderScopeCursor(); } },
    { id: "sidebar.bottom", title: "Fin de la lista", run: () => { active = Math.max(0, visibleNotes().length - 1); render(); renderScopeCursor(); } },
];
for (const c of cmds) registry.register(c);

/* Extra app-level bindings layered on top of the abstract DEFAULT_KEYMAP. */
const APP_BINDINGS: Binding[] = [
    { keys: "g", scope: SIDEBAR, command: "sidebar.top" },
    { keys: "shift+g", scope: SIDEBAR, command: "sidebar.bottom" },
];
const keymap = new Keymap([...DEFAULT_KEYMAP, ...APP_BINDINGS]);
const dispatcher = new InputDispatcher(keymap, registry, () => scope);

/* Back-compat shim: legacy callers (toolbar +, setView) used setMode("insert")
   to mean "focus the composer to start a note". Map it onto the scope machine. */
function setMode(next: "insert" | "normal") {
    if (next === "insert") focusCompose();
    else setScope(prevScope === COMPOSE ? DOCUMENT : prevScope);
}

/* Composer caret mirror. */
cmdInput.addEventListener("input", updateBarCaret);

/* ───────────────────────── Document pane interaction ─────────────────────────
   Clicking into the CodeMirror editor enters the document scope so the statusline
   mode badge and the focused-pane ring track it. Vim then owns the keyboard until
   a pane-nav chord (ctrl+h/l) takes focus elsewhere. */
detailScroll.addEventListener("focusin", (ev) => {
    const el = ev.target as HTMLElement | null;
    if (el && el.closest(".cm-editor") && scope !== DOCUMENT && scope !== LEADER) {
        setScope(DOCUMENT);
    }
});

/* ───────────────────────── Global keydown → dispatcher ─────────────────────────
   When the cmdline is open it owns input. Otherwise: while typing (composer
   focused, or editing a prose block), only let modified chords / Escape / Enter
   reach the dispatcher so plain text keeps flowing into the field; everywhere
   else, every chord is a candidate command. */
window.addEventListener("keydown", (ev) => {
    if (cmdline.isOpen()) return;

    // While a leader sequence is pending, every keystroke is part of it (and is
    // echoed into the statusline) — it never reaches the editor or the dispatcher.
    if (leaderActive) { ev.preventDefault(); handleLeaderKey(ev); return; }

    const t = ev.target as HTMLElement | null;

    // `?` opens the welcome / guía from anywhere — except while typing in a field or
    // inside the vim editor (where `?` is vim's reverse search). Closing is owned by
    // the HelpPage's own capture handler.
    if (ev.key === "?" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !help.open()) {
        const inEditor = !!t && !!t.closest(".cm-editor");
        const typingNow = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!inEditor && !typingNow) { ev.preventDefault(); help.show(); return; }
    }

    // The card timeline owns j/k/g/G navigation while it is the active surface and
    // nothing is being typed. `:` / `i` etc. fall through to the dispatcher/cmdline.
    if (view === "timeline" && !cmdline.isOpen()) {
        const typingNow = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
        if (!typingNow && plain) {
            if (ev.key === "j" || ev.key === "ArrowDown") { ev.preventDefault(); moveCardCursor(1); return; }
            if (ev.key === "k" || ev.key === "ArrowUp") { ev.preventDefault(); moveCardCursor(-1); return; }
            if (ev.key === "g") { ev.preventDefault(); jumpCardCursor("top"); return; }
            if (ev.key === "G") { ev.preventDefault(); jumpCardCursor("bottom"); return; }
            // i / o open the card composer; Enter focuses the cursor card (its thread);
            // l links a sibling, p nests a child under the cursor card.
            if (ev.key === "i" || ev.key === "o") {
                ev.preventDefault();
                cmdline.show({ intent: "card" });
                return;
            }
            if (ev.key === "Enter") {
                ev.preventDefault();
                if (cursorCardId) void openCardFocus(cursorCardId);
                return;
            }
            if (ev.key === "l") { ev.preventDefault(); openLinkComposer(); return; }
            if (ev.key === "p") { ev.preventDefault(); openLinkComposer(undefined, "parent"); return; }
        }
    }

    // The card focus/thread view owns its own minimal key set: Esc/h/q step back to
    // the timeline; i/o compose; l links a sibling and p nests a child under the
    // focused card. Click navigates between related cards.
    if (view === "card" && !cmdline.isOpen()) {
        const typingNow = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
        if (!typingNow && plain) {
            if (ev.key === "Escape" || ev.key === "h" || ev.key === "q") { ev.preventDefault(); backToTimeline(); return; }
            if (ev.key === "i" || ev.key === "o") { ev.preventDefault(); cmdline.show({ intent: "card" }); return; }
            if (ev.key === "l" && focusCard) { ev.preventDefault(); openLinkComposer(focusCard); return; }
            if (ev.key === "p" && focusCard) { ev.preventDefault(); openLinkComposer(focusCard, "parent"); return; }
        }
    }

    // The CodeMirror editor IS real vim — it owns every keystroke (motions,
    // insert, Escape→normal, `:`→ex-line, its own undo). The app only reclaims the
    // pane-nav chords (ctrl+h / ctrl+l) that let you step out to another pane;
    // everything else flows untouched to vim. Letting Escape/Enter/`:`/space reach
    // the dispatcher here would fight vim's own handling.
    if (t && t.closest(".cm-editor")) {
        const chord = parseChord(ev);
        if (chord === "ctrl+h" || chord === "ctrl+l") {
            if (dispatcher.handle(ev)) ev.preventDefault();
        }
        return;
    }

    // "Typing" is decided by the actual focused element (the composer input), NOT
    // by logical scope state — so a stale scope can never wrongly swallow command
    // keys or steal field keystrokes. While typing, only modified chords / Escape /
    // Enter reach the dispatcher so plain text keeps flowing into the field.
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const isMod = ev.ctrlKey || ev.metaKey || ev.altKey;
    if (typing && !isMod && ev.key !== "Escape" && ev.key !== "Enter") return;

    if (dispatcher.handle(ev)) ev.preventDefault();
});

/* ───────────────────────── Boot ───────────────────────── */
renderSidebar();
applyView();          // mounts + shows the primary surface (the card timeline)
// Land in a navigation scope (not the composer) so the statusline stays thin:
// the composer only appears when you deliberately compose (i / leader→c / →n).
setScope(DOCUMENT);
updateBarCaret();
void loadNotes();
void loadCards();
