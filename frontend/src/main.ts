import "./style.css";
import { Cmdline } from "./cmdline.js";
import { NoteService, Note, NewNote, Anchor, Block, type Document, type Card } from "../bindings/github.com/Gabosequera/noteit_app/index.js";
import { tagColor, type ParsedStatement } from "./statement.js";
import {
    CommandRegistry,
    InputDispatcher,
    Keymap,
    DEFAULT_KEYMAP,
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
const toastEl = document.getElementById("toast")!;

let active = 0;                                   // index into visibleNotes()
let viewMode: "folder" | "tree" = "folder";
let tagFilter: string | null = null;             // when set, list is filtered to a tag/"folder"
let baseFolder = "devlog";

/* The open note rendered as a document of blocks (prose + status cards). Loaded
   lazily when the active note changes; the .md file is the source of truth. */
let activeDoc: Document | null = null;
let loadingDocId: string | null = null;
let docReq = 0;                       // monotonic token: only the newest fetch may commit
const docFailed = new Set<string>();  // notes whose load errored — don't auto-retry (no render loop)

/* ───────────────────────── Cursor scope state ─────────────────────────
   The keyboard model is vscode/nvim-style: the app tracks which *scope* the
   cursor lives in (sidebar list, document body, or the compose box), plus the
   cursor position within the document. Keys are mapped to abstract commands by
   the Keymap; the command implementations below read/mutate this state. */
let scope: Scope = COMPOSE;       // focused pane; COMPOSE = bottom composer
let prevScope: Scope = DOCUMENT;  // scope to restore from a transient LEADER
let docCursor = 0;                // index into docBlockEls() while scope === DOCUMENT
let editing = false;              // true while a prose block is being edited (contenteditable focused)
let composeIntent: "card" | "note" = "card"; // what Enter in the composer creates
let leaderActive = false;                    // true while a leader key sequence is being captured
let leaderSeq: string[] = [];                // chords pressed after the leader key (shown in the statusline)
let statusTimer: number | undefined;         // clears a transient showcmd notice
let proseTimer: number | undefined;          // debounce handle for prose autosave
let saveReq = 0;                             // monotonic token: only the newest save may commit its response

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* escAttr also neutralizes quotes so a value is safe inside a quoted HTML
   attribute (defense-in-depth for ids that may later be imported/synced). */
const escAttr = (s: string) => escHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* With a note open, the composer always writes a status card on Enter. The `:**`
   marker (and the `space space` shortcut that expands to it) is an explicit, muscle-
   memory way to start one; it is purely a prefix we strip from the body before
   sending, not a behavioral switch. stripCardPrefix removes it if present. */
const CARD_PREFIX = ":**";
function stripCardPrefix(s: string): string {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith(CARD_PREFIX)) return t.slice(CARD_PREFIX.length).replace(/^\s+/, "");
    return s;
}

/* bodyPreview builds the one-line sidebar snippet. Card fences (`:::card …` and
   the bare `:::` close) are dropped so the list shows readable prose/status text,
   never raw fence syntax. */
function bodyPreview(body: string): string {
    const cleaned = (body ?? "")
        .split("\n")
        .filter((l) => {
            const t = l.replace(/\r$/, "").trimStart();   // tolerate indented fences
            return !t.startsWith(":::card") && t !== ":::";
        })
        .join(" ");
    return cleaned.replace(/[#>*`\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
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

/* ───────────────────────── Tiny markdown renderer ───────────────────────── */
function inlineMd(s: string): string {
    let h = escHtml(s);
    h = h.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
    return h;
}
function renderMarkdown(src: string): string {
    if (!src.trim()) return `<p style="color:var(--fg-mute)">nota vacía.</p>`;
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let listType: "ul" | "ol" | null = null;
    let inCode = false; let codeBuf: string[] = [];
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

    for (const raw of lines) {
        const line = raw;
        const fence = line.trim().startsWith("```");
        if (fence) {
            if (inCode) { out.push(`<pre><code>${escHtml(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; inCode = false; }
            else { closeList(); inCode = true; }
            continue;
        }
        if (inCode) { codeBuf.push(line); continue; }

        if (!line.trim()) { closeList(); continue; }

        let m: RegExpMatchArray | null;
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
            closeList(); const lvl = m[1].length; out.push(`<h${lvl}>${inlineMd(m[2])}</h${lvl}>`); continue;
        }
        if (/^\s*([-*_])\1\1+\s*$/.test(line)) { closeList(); out.push("<hr/>"); continue; }
        if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
            if (listType !== "ul") { closeList(); out.push('<ul style="list-style:none;padding-left:0">'); listType = "ul"; }
            const done = m[1].toLowerCase() === "x";
            out.push(`<li class="task${done ? " done" : ""}"><span class="box">${done ? "✓" : ""}</span><span>${inlineMd(m[2])}</span></li>`);
            continue;
        }
        if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
            if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
            out.push(`<li>${inlineMd(m[1])}</li>`); continue;
        }
        if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
            if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
            out.push(`<li>${inlineMd(m[1])}</li>`); continue;
        }
        if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`); continue; }
        closeList(); out.push(`<p>${inlineMd(line)}</p>`);
    }
    if (inCode) out.push(`<pre><code>${escHtml(codeBuf.join("\n"))}</code></pre>`);
    closeList();
    return out.join("");
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
/* A single status card, rendered like the reference design: a timestamped,
   authored block with the body as (code-aware) markdown. Card content is kept
   verbatim by the backend, so what you typed is what renders. */
function renderCardBlock(c: Card): string {
    const ts = fmtWhen(c.created);
    const author = escHtml(c.author || "local");
    const links = c.links ?? [];
    const linkBadge = links.length
        ? `<span class="sc-links" title="${links.length} enlace(s) a otras tarjetas">↬ ${links.length}</span>`
        : "";
    return `<article class="status-card" data-card-id="${escAttr(c.id)}">
        <header class="sc-head">
            <span class="sc-ts">${ts}</span>
            <span class="sc-spacer"></span>
            ${linkBadge}
            <span class="sc-author">${author}</span>
        </header>
        <div class="sc-body md">${renderMarkdown(c.body || "")}</div>
    </article>`;
}

/* Render the open note as an interleaved document: prose blocks and cards in the
   exact order they appear in the file.

   Every block is emitted (even empty prose) so the rendered element index lines
   up 1:1 with the block index — that `data-bi` is the bridge between a DOM node
   (clicked or cursored) and the model entry it edits. Prose is a plain-text
   contenteditable surface (we edit the markdown SOURCE, not rendered HTML); cards
   stay read-only here and get their own edit affordances later. */
function renderDocBlocks(doc: Document): string {
    const blocks = doc.blocks ?? [];
    if (blocks.length === 0) {
        return `<div class="doc-empty">documento vacío — escribí abajo y pulsá <kbd>⏎</kbd> para tu primera tarjeta de estatus, o entrá al documento (<kbd>ctrl+k</kbd>) y empezá a escribir prosa.</div>`;
    }
    let html = "";
    blocks.forEach((b, i) => {
        if (b.kind === "card" && b.card) {
            html += renderCardBlock(b.card);
        } else {
            const text = b.text ?? "";
            html += `<div class="doc-prose" contenteditable="true" spellcheck="false" data-bi="${i}" data-placeholder="escribí prosa…">${escHtml(text)}</div>`;
        }
    });
    return html;
}

/* All cursorable/editable document elements in render order. Index === block
   index because renderDocBlocks emits one element per block. */
function docBlockEls(): HTMLElement[] {
    return Array.from(detailScroll.querySelectorAll<HTMLElement>(".status-card, .doc-prose"));
}

function renderDetail() {
    const list = visibleNotes();
    if (list.length === 0) {
        detailScroll.innerHTML = `<div class="detail-empty"><p>aún no hay notas — escribí abajo y pulsá <kbd>⏎</kbd></p></div>`;
        return;
    }
    if (active >= list.length) active = list.length - 1;
    if (active < 0) active = 0;
    const n = list[active];

    // Document body: use the parsed blocks when they belong to this note; while a
    // different note's document is still loading, fall back to the raw markdown so
    // switching notes never shows a blank pane.
    let bodyHtml: string;
    if (activeDoc && activeDoc.note && activeDoc.note.id === n.id) {
        bodyHtml = renderDocBlocks(activeDoc);
    } else {
        // Raw markdown is a safe fallback while the parsed document loads. We only
        // kick off a fetch when one isn't already running AND this note hasn't just
        // failed — otherwise the error path's re-render would retry forever.
        bodyHtml = `<div class="md">${renderMarkdown(n.body)}</div>`;
        if (loadingDocId !== n.id && !docFailed.has(n.id)) void loadActiveDocument(n.id);
    }

    detailScroll.innerHTML =
        `<div class="dn-head">
            <span class="when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
            <span class="who">${escHtml(n.who)}</span>
        </div>
        <h1 class="dn-title"><span class="hash">#</span>${escHtml(n.title)}</h1>
        ${metaBlock(n)}
        ${bodyHtml}
        ${anchorsBlock(n)}`;
    detailScroll.scrollTop = 0;
    // The innerHTML rebuild above wiped any `.is-cursor`; if the document is the
    // focused scope (incl. while a leader chord is pending over it), repaint it so
    // async loads / re-renders don't drop the cursor highlight.
    const cur = scope === LEADER ? prevScope : scope;
    if (cur === DOCUMENT) { clampDocCursor(); renderScopeCursor(); }
}

/* Lazily fetch the active note's parsed document. Guarded so a burst of renders
   (e.g. fast j/k navigation) issues at most one in-flight fetch per note. */
async function loadActiveDocument(id: string) {
    if (loadingDocId === id) return;
    loadingDocId = id;
    const token = ++docReq;
    try {
        const doc = await NoteService.GetDocument(id);
        if (token !== docReq) return;        // a newer navigation superseded this fetch
        activeDoc = doc;
        docFailed.delete(id);
    } catch (err) {
        console.error("GetDocument failed", err);
        if (token === docReq) docFailed.add(id);  // stop auto-retry; reload clears this
    } finally {
        if (loadingDocId === id) loadingDocId = null;
        renderDetail();
    }
}

/* ───────────────────────── Sidebar (note list / tree) ───────────────────────── */
function renderSidebar() {
    sidebar.classList.toggle("tree-mode", viewMode === "tree");
    folderName.textContent = viewMode === "tree" ? "notes" : (tagFilter ?? baseFolder);
    sidebarBody.innerHTML = "";

    if (viewMode === "tree") { renderTree(); return; }

    const list = visibleNotes();
    if (list.length === 0) {
        sidebarBody.innerHTML = `<div class="sidebar-empty">Carpeta vacía.<br/>Pulsá <kbd>+</kbd> o <kbd>i</kbd> para una nota nueva.</div>`;
        return;
    }
    if (active >= list.length) active = list.length - 1;
    if (active < 0) active = 0;

    list.forEach((n, i) => {
        const el = document.createElement("div");
        el.className = "note-item" + (i === active ? " is-active" : "");
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
        // Render first, then setScope: setScope's renderScopeCursor must paint
        // `.is-cursor` onto the freshly rebuilt DOM, not onto nodes we're about
        // to discard.
        el.addEventListener("click", () => { active = i; renderSidebar(); renderDetail(); setScope(SIDEBAR); });
        sidebarBody.appendChild(el);
    });
    sidebarBody.children[active]?.scrollIntoView({ block: "nearest" });
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

/* Re-render both panes. */
function render() { renderSidebar(); renderDetail(); }

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
        docFailed.clear();   // a fresh load is the user's retry path for previously-failed docs
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

/* addCardToActive appends a status card to the currently open note. The returned
   Document already carries the freshly-parsed blocks, so we adopt it directly
   instead of issuing a second GetDocument round-trip — keeping the write path
   lightning-fast. The note's raw body is patched in place so the sidebar preview
   and any markdown fallback stay consistent without a full reload. */
async function addCardToActive(body: string) {
    const list = visibleNotes();
    if (list.length === 0) { notify("no hay nota activa para una tarjeta"); return; }
    const text = body.trim();
    if (!text || creating) return;
    const id = list[active].id;
    creating = true;
    try {
        const doc = await NoteService.AddCard(id, text);
        activeDoc = doc;
        const idx = NOTES.findIndex((n) => n.id === id);
        if (idx >= 0) NOTES[idx].body = doc.note?.body ?? NOTES[idx].body;
        cmdInput.value = "";
        updateBarCaret();
        renderSidebar();
        renderDetail();
        const cards = detailScroll.querySelectorAll(".status-card");
        cards[cards.length - 1]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        notify("✓ tarjeta de estatus");
    } catch (err) {
        console.error("AddCard failed", err);
        notify("no se pudo crear la tarjeta");
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
addBtn.addEventListener("click", () => { setMode("insert"); notify("✎ new note"); });

document.querySelectorAll<HTMLElement>(".tool").forEach((el) => {
    el.addEventListener("click", () => {
        const tool = el.dataset.tool;
        document.querySelectorAll(".tool").forEach((t) => t.classList.remove("is-active"));
        if (tool === "tree" || tool === "tags") { el.classList.add("is-active"); setView("tree"); }
        else if (tool === "search") { cmdline.show(); }
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
        .then((es) => es.map((e) => ({ name: e.name, isDir: e.isDir })))
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
    // Leaving the document/edit context: fully exit the prose editor (blur, clear
    // `editing`) and flush any pending save so no stale edit state leaks across.
    if ((scope === DOCUMENT || editing) && next !== DOCUMENT && next !== LEADER) {
        exitProseEdit();
    }

    if (next !== LEADER) prevScope = next;
    scope = next;

    const inCompose = next === COMPOSE;
    cmdInput.readOnly = !inCompose;
    cmdbar.classList.toggle("normal", !inCompose);
    modeEl.textContent = scopeLabel(next);

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

    // Entering the composer always defaults to writing a status card; the
    // "create a note" intent is a deliberate one-shot set AFTER this by
    // focusCompose, and reset on submit — so it can never leak across navigation.
    if (next === COMPOSE) composeIntent = "card";

    if (next === DOCUMENT) clampDocCursor();
    if (next !== LEADER) closeLeader();

    applyScopeClasses();
    renderScopeCursor();
}

function scopeLabel(s: Scope): string {
    switch (s) {
        case COMPOSE: return "-- COMPOSE --";
        case SIDEBAR: return "-- NOTES --";
        case DOCUMENT: return "-- DOC --";
        case LEADER: return "-- LEADER --";
        default: return `-- ${s.toUpperCase()} --`;
    }
}

/* Paint the focused-pane accent ring on whichever pane owns the cursor. */
function applyScopeClasses() {
    const ref = scope === LEADER ? prevScope : scope;
    sidebar.classList.toggle("scope-focus", ref === SIDEBAR);
    detailScroll.classList.toggle("scope-focus", ref === DOCUMENT);
    cmdbar.classList.toggle("scope-focus", ref === COMPOSE);
}

/* Highlight the single cursored element inside the focused nav scope. */
function renderScopeCursor() {
    document.querySelectorAll(".is-cursor").forEach((el) => el.classList.remove("is-cursor"));
    const ref = scope === LEADER ? prevScope : scope;
    if (ref === SIDEBAR) {
        const el = sidebarBody.children[active] as HTMLElement | undefined;
        if (el) { el.classList.add("is-cursor"); el.scrollIntoView({ block: "nearest" }); }
    } else if (ref === DOCUMENT) {
        const el = docBlockEls()[docCursor];
        if (el) { el.classList.add("is-cursor"); el.scrollIntoView({ block: "nearest" }); }
    }
}

function clampDocCursor() {
    const n = docBlockEls().length;
    if (n === 0) { docCursor = 0; return; }
    if (docCursor < 0) docCursor = 0;
    if (docCursor >= n) docCursor = n - 1;
}

/* ───────────────────────── Command implementations ───────────────────────── */

/* Vertical motion. In the document the cursor walks blocks; stepping past the
   bottom drops into the composer, and ctrl+k from the composer climbs into the
   document's last block — the seamless compose↔document edge the user asked for. */
function cursorMove(delta: number) {
    if (editing && document.activeElement instanceof HTMLElement) document.activeElement.blur();

    if (scope === SIDEBAR) { move(delta); renderScopeCursor(); return; }

    if (scope === COMPOSE) {
        if (delta < 0) {
            const els = docBlockEls();
            if (els.length > 0) { docCursor = els.length - 1; setScope(DOCUMENT); }
            else if (activeDoc && activeDoc.note) proseNew();   // empty doc: start prose
        }
        return;
    }

    if (scope === DOCUMENT) {
        const els = docBlockEls();
        if (els.length === 0) { setScope(COMPOSE); return; }
        const next = docCursor + delta;
        if (next < 0) { docCursor = 0; renderScopeCursor(); return; }
        if (next >= els.length) { setScope(COMPOSE); return; }   // past the bottom → composer
        docCursor = next;
        renderScopeCursor();
    }
}

/* Horizontal scope jump (ctrl+h / ctrl+l): move between adjacent panes per the
   SCOPE_LEFT / SCOPE_RIGHT adjacency tables. */
function scopeMove(dir: "left" | "right") {
    const table = dir === "left" ? SCOPE_LEFT : SCOPE_RIGHT;
    const target = table[scope];
    if (target) setScope(target);
}

/* Escape: collapse a transient scope back toward the composer. Leader → its
   underlying scope; any nav scope → composer. */
function escapeScope() {
    // Cancel a pending leader sequence back to the underlying scope.
    if (scope === LEADER) { setScope(prevScope); return; }
    // Editing a prose block: stop editing but stay in the document for nav.
    if (editing) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setScope(DOCUMENT);
        return;
    }
    // Leaving the composer returns to document navigation (Escape never *opens*
    // the composer — like nvim, Escape only ever drops you back toward NORMAL).
    if (scope === COMPOSE) { setScope(DOCUMENT); return; }
    // Already in a nav scope: nothing to escape.
}

function focusCompose() {
    setScope(COMPOSE);       // resets intent to "card"…
    composeIntent = "note";  // …then mark this one-shot as a note-create.
}

/* Compose submit (Enter in the composer). With a note open it writes a status
   card; with no notes yet it bootstraps the first note from the typed title. */
function submitCompose() {
    if (composeIntent === "note" || visibleNotes().length === 0) {
        void createNoteFromInput();
    } else {
        void addCardToActive(stripCardPrefix(cmdInput.value));
    }
    composeIntent = "card";
}

/* Enter edit on the cursored document block: prose blocks focus their
   contenteditable surface; cards have no inline editor yet. */
function editDocCursor() {
    const el = docBlockEls()[docCursor];
    if (el && el.classList.contains("doc-prose")) {
        el.focus();
        placeCaretEnd(el);
    } else {
        notify("edición de tarjetas: próximamente");
    }
}

/* Append a fresh empty prose block to the open document and drop the caret into
   it. The block lives only in memory until the user types — an empty prose block
   canonicalizes away on save, so we don't persist it eagerly; the first edit's
   debounced save is what writes it to disk. This is the entry point for writing
   prose into an otherwise empty (card-only or brand-new) document. */
function proseNew() {
    if (!activeDoc || !activeDoc.note) { notify("abrí una nota primero"); return; }
    activeDoc.blocks = [...(activeDoc.blocks ?? []), Block.createFrom({ kind: "text", text: "" })];
    setScope(DOCUMENT);
    renderDetail();
    const els = docBlockEls();
    docCursor = Math.max(0, els.length - 1);
    const el = els[docCursor];
    if (el && el.classList.contains("doc-prose")) { el.focus(); placeCaretEnd(el); }
}

function placeCaretEnd(el: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
}

/* Single exit point for prose editing: blur the focused contenteditable (which
   fires focusout → editing=false → flush) and defensively clear `editing` so no
   scope transition can leave the keydown guard thinking we're still typing. */
function exitProseEdit() {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.classList.contains("doc-prose")) {
        el.blur();              // focusout handler flushes the pending save
    } else if (editing) {
        void flushProseSave();  // editing flagged but nothing focused: flush anyway
    }
    editing = false;
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

/* ───────────────────────── Prose autosave (contenteditable → SaveDocument) ─────────────────────────
   Prose blocks edit the markdown SOURCE. Edits sync into the in-memory block
   model immediately and persist on a debounce; the .md file stays source of
   truth. Prose edits are NOT card lifecycle events, so SaveDocument appends no
   journal entry. */
function scheduleProseSave() {
    clearTimeout(proseTimer);
    proseTimer = window.setTimeout(() => { void flushProseSave(); }, 700);
}

/* Copy every prose element's current text back into activeDoc.blocks by index. */
function syncProseToModel() {
    if (!activeDoc) return;
    const blocks = activeDoc.blocks ?? [];
    detailScroll.querySelectorAll<HTMLElement>(".doc-prose").forEach((el) => {
        const bi = Number(el.dataset.bi);
        if (Number.isInteger(bi) && blocks[bi] && blocks[bi].kind !== "card") {
            blocks[bi].text = el.innerText;
        }
    });
}

async function flushProseSave() {
    clearTimeout(proseTimer);
    if (!activeDoc || !activeDoc.note) return;
    syncProseToModel();
    const id = activeDoc.note.id;
    const token = ++saveReq;                         // newest save wins
    const wasEditing = editing;                      // snapshot: are we mid-edit right now?
    const blocks = (activeDoc.blocks ?? []).map((b) => Block.createFrom(b));
    try {
        const doc = await NoteService.SaveDocument(id, blocks);

        // Ignore the response if a newer save started, or the user navigated to a
        // different note while this was in flight — otherwise we'd clobber newer
        // state with this stale canonical body.
        if (token !== saveReq) return;
        if (!activeDoc || !activeDoc.note || activeDoc.note.id !== id) return;

        // Keep the sidebar preview fresh regardless.
        const idx = NOTES.findIndex((n) => n.id === id);
        if (idx >= 0) { NOTES[idx].body = doc.note?.body ?? NOTES[idx].body; renderSidebar(); }

        // The backend canonicalizes (merges/drops prose), so its block list can
        // differ from the live DOM. Only adopt the canonical document + re-render
        // when we are NOT mid-edit: re-rendering rebuilds the DOM (resetting the
        // data-bi mapping) and would otherwise destroy the focused caret. While
        // editing, leave the DOM as the live source and resync on blur.
        if (!wasEditing && !editing) {
            activeDoc = doc;
            if (activeDoc.note && activeDoc.note.id === id) renderDetail();
        }
    } catch (err) {
        console.error("SaveDocument failed", err);
        notify("no se pudo guardar la prosa");
    }
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
    { id: "card.create", title: "Nueva tarjeta", run: () => { closeLeader(); composeIntent = "card"; setScope(COMPOSE); } },
    { id: "document.editCursor", title: "Editar bloque", run: () => editDocCursor() },
    { id: "prose.new", title: "Nueva prosa", run: () => { closeLeader(); proseNew(); } },
    { id: "sidebar.top", title: "Inicio de la lista", run: () => { active = 0; render(); renderScopeCursor(); } },
    { id: "sidebar.bottom", title: "Fin de la lista", run: () => { active = Math.max(0, visibleNotes().length - 1); render(); renderScopeCursor(); } },
];
for (const c of cmds) registry.register(c);

/* Extra app-level bindings layered on top of the abstract DEFAULT_KEYMAP. */
const APP_BINDINGS: Binding[] = [
    { keys: "g", scope: SIDEBAR, command: "sidebar.top" },
    { keys: "shift+g", scope: SIDEBAR, command: "sidebar.bottom" },
    { keys: "p", scope: LEADER, command: "prose.new" },
];
const keymap = new Keymap([...DEFAULT_KEYMAP, ...APP_BINDINGS]);
const dispatcher = new InputDispatcher(keymap, registry, () => scope);

/* Back-compat shim: legacy callers (toolbar +, setView) used setMode("insert")
   to mean "focus the composer to start a note". Map it onto the scope machine. */
function setMode(next: "insert" | "normal") {
    // focusCompose() sets the one-shot "note" intent AFTER entering COMPOSE,
    // so it survives setScope's reset-to-"card" on COMPOSE entry.
    if (next === "insert") focusCompose();
    else setScope(prevScope === COMPOSE ? DOCUMENT : prevScope);
}

/* Composer caret mirror only (no more space-space → :** expansion). */
cmdInput.addEventListener("input", updateBarCaret);

/* ───────────────────────── Document pane interaction (mouse + edit) ─────────────────────────
   Clicking a card or prose block focuses the document scope at that block; a
   prose block additionally enters edit mode on focusin. */
detailScroll.addEventListener("mousedown", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>(".status-card, .doc-prose");
    if (!target) return;
    const idx = docBlockEls().indexOf(target);
    if (idx >= 0) { docCursor = idx; setScope(DOCUMENT); }
});
detailScroll.addEventListener("focusin", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>(".doc-prose");
    if (!el) return;
    const idx = docBlockEls().indexOf(el);
    if (idx >= 0) docCursor = idx;
    // Enter the document scope through the one state-machine entry point so
    // prevScope/labels/cursor paint stay consistent, THEN mark editing (setScope
    // does not blur a freshly-focused prose element since next === DOCUMENT).
    if (scope !== DOCUMENT) setScope(DOCUMENT);
    editing = true;
});
detailScroll.addEventListener("input", (ev) => {
    if ((ev.target as HTMLElement).classList.contains("doc-prose")) scheduleProseSave();
});
detailScroll.addEventListener("focusout", (ev) => {
    if (!(ev.target as HTMLElement).classList.contains("doc-prose")) return;
    editing = false;
    void flushProseSave();
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

    // "Typing" is decided by the actual focused element (the composer input or a
    // contenteditable prose block), NOT by logical scope state — so a stale scope
    // can never wrongly swallow command keys or steal editor keystrokes. While
    // typing, only modified chords / Escape / Enter reach the dispatcher so plain
    // text keeps flowing into the field.
    const t = ev.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const isMod = ev.ctrlKey || ev.metaKey || ev.altKey;
    if (typing && !isMod && ev.key !== "Escape" && ev.key !== "Enter") return;

    if (dispatcher.handle(ev)) ev.preventDefault();
});

/* ───────────────────────── Boot ───────────────────────── */
render();
// Land in a navigation scope (not the composer) so the statusline stays thin:
// the composer only appears when you deliberately compose (i / leader→c / →n).
setScope(DOCUMENT);
updateBarCaret();
void loadNotes();
