import "./style.css";
import { Cmdline } from "./cmdline.js";
import { NoteService, Note, NewNote, Anchor } from "../bindings/github.com/Gabosequera/noteit_app/index.js";
import { tagColor, type ParsedStatement } from "./statement.js";

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
const cmdInput = document.getElementById("cmdInput") as HTMLInputElement;
const modeEl = document.getElementById("mode")!;
const barCaret = document.getElementById("barCaret")!;
const barMirror = document.getElementById("barMirror")!;
const toastEl = document.getElementById("toast")!;

let active = 0;                                   // index into visibleNotes()
let viewMode: "folder" | "tree" = "folder";
let tagFilter: string | null = null;             // when set, list is filtered to a tag/"folder"
let baseFolder = "devlog";

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
function renderDetail() {
    const list = visibleNotes();
    if (list.length === 0) {
        detailScroll.innerHTML = `<div class="detail-empty"><p>no notes yet — press <kbd>i</kbd>, type a title, hit <kbd>⏎</kbd></p></div>`;
        return;
    }
    if (active >= list.length) active = list.length - 1;
    if (active < 0) active = 0;
    const n = list[active];
    detailScroll.innerHTML =
        `<div class="dn-head">
            <span class="when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
            <span class="who">${escHtml(n.who)}</span>
        </div>
        <h1 class="dn-title"><span class="hash">#</span>${escHtml(n.title)}</h1>
        ${metaBlock(n)}
        <div class="md">${renderMarkdown(n.body)}</div>
        ${anchorsBlock(n)}`;
    detailScroll.scrollTop = 0;
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
        const preview = n.body.replace(/[#>*`\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
        const tags = n.tags.slice(0, 3).map((t) => `<span class="ni-tag" style="--c:${tagColor(t)}">${escHtml(t)}</span>`).join("");
        el.innerHTML =
            `<div class="ni-top">
                <span class="ni-dot" style="--c:${n.color}"></span>
                <span class="ni-title">${escHtml(n.title)}</span>
                <span class="ni-when">${escHtml(n.whenShort)}</span>
            </div>
            ${preview ? `<div class="ni-sub">${escHtml(preview)}</div>` : ""}
            ${tags ? `<div class="ni-tags">${tags}</div>` : ""}`;
        el.addEventListener("click", () => { active = i; renderSidebar(); renderDetail(); });
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
addBtn.addEventListener("click", () => { setMode("insert"); notify("✎ new note"); });

document.querySelectorAll<HTMLElement>(".tool").forEach((el) => {
    el.addEventListener("click", () => {
        const tool = el.dataset.tool;
        document.querySelectorAll(".tool").forEach((t) => t.classList.remove("is-active"));
        if (tool === "tree" || tool === "tags") { el.classList.add("is-active"); setView("tree"); }
        else if (tool === "search") { cmdline.show(); }
        else if (tool === "settings") { toggleTheme(); }
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
    createNoteFull: (st) => { void createNoteFromStatement(st); }
});

/* ───────────────────────── Modes: INSERT / NORMAL ───────────────────────── */
type Mode = "insert" | "normal";
let mode: Mode = "insert";

function setMode(next: Mode) {
    mode = next;
    cmdbar.classList.toggle("normal", mode === "normal");
    modeEl.textContent = mode === "insert" ? "-- INSERT --" : "-- NORMAL --";
    cmdInput.readOnly = mode === "normal";
    if (mode === "insert") cmdInput.focus();
    else { cmdInput.blur(); updateBarCaret(); }
}

cmdInput.addEventListener("input", updateBarCaret);

window.addEventListener("keydown", (ev) => {
    if (cmdline.isOpen()) return;

    if (ev.key === ":" && mode === "normal") { ev.preventDefault(); cmdline.show(); return; }
    if (ev.key === "Escape") { setMode("normal"); return; }

    if (mode === "normal") {
        if (ev.key === "j" || ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
        else if (ev.key === "k" || ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
        else if (ev.key === "i" || ev.key === "a") { setMode("insert"); ev.preventDefault(); }
        else if (ev.key === "g") { active = 0; render(); ev.preventDefault(); }
        else if (ev.key === "G") { active = Math.max(0, visibleNotes().length - 1); render(); ev.preventDefault(); }
        return;
    }

    // INSERT mode
    if (ev.key === "Enter") { ev.preventDefault(); void createNoteFromInput(); return; }
    if (ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
});

render();
setMode("insert");
updateBarCaret();
void loadNotes();
