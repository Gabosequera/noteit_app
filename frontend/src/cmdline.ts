/* ───────────────────────────── noteit · cmdline ─────────────────────────────
   nvim-style command line. Se abre con `:` y deja alcanzar CUALQUIER parte de
   la app escribiendo. Incluye:
     · registry extensible de comandos (cada vista/acción es un comando)
     · fuzzy matching
     · Tab para autocompletar (cicla entre matches)
     · historial (↑/↓) y ranking por frecuencia (persistido en localStorage)
     · cursor de bloque estilo nvim (buffer manejado, no <input>)
   La navegación real del filesystem necesita una binding de Go (ver runFs). */

import { parseStatement, tagColor, type ParsedStatement } from "./statement.js";
import { parseCardInput, previewVM, linkTargetVM, type LinkTarget } from "./cards/cardData.js";
import { buildCardEl } from "./cards/cardView.js";

export interface CmdContext {
    arg: string;             // texto después del nombre del comando
    notify: (msg: string) => void;
}

export interface Command {
    id: string;              // nombre canónico, lo que tipeás tras `:`
    aliases?: string[];
    hint: string;            // descripción corta en la lista
    group: "view" | "note" | "tag" | "app" | "fs";
    takesArg?: boolean;      // acepta argumento (ej: `tag rust`, `e ~/notes`)
    run: (ctx: CmdContext) => void;
}

export interface CmdlineDeps {
    setView: (view: string) => void;
    jumpToNote: (index1: number) => void;
    noteCount: () => number;
    filterTag: (tag: string) => void;
    listTags: () => string[];
    toggleTheme: () => void;
    notify: (msg: string) => void;
    runFs: (op: "cd" | "e", path: string) => void; // hook backend (Go/Wails)
    reloadNotes: () => void;                        // re-read notes from disk (Go backend)
    addAnchor: (file: string, lines: string) => void; // anchor active note to code
    createNoteFull: (st: ParsedStatement) => void;    // create a note from a `:*` statement
    listDir: (input: string) => Promise<FinderEntry[]>; // per-directory file finder (Go backend)
    createCard: (body: string, tags: string[], linkId: string | null, linkKind: "" | "link" | "parent") => void; // mint a card (CardService)
    showTimeline: () => void;                         // switch the detail pane to the card timeline
    openActiveDoc: () => void;                         // open the active note as the (embed-capable) doc surface
    showHelp: () => void;                              // open the welcome / guía overlay
}

/* how the cmdline opens: as the command palette (`:`) or the card composer (`›`). */
export interface CmdlineShowOpts {
    intent?: "card" | "command";
    linkTarget?: LinkTarget | null;
}

export interface FinderEntry { name: string; isDir: boolean; }

const FREQ_KEY = "noteit.cmd.freq";
const HIST_KEY = "noteit.cmd.history";

function loadJSON<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) ?? "") as T; }
    catch { return fallback; }
}
function saveJSON(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/* fuzzy: devuelve score (mayor = mejor) o -1 si no matchea en orden */
function fuzzy(query: string, target: string): number {
    if (!query) return 0;
    query = query.toLowerCase();
    target = target.toLowerCase();
    let qi = 0, score = 0, streak = 0, prevIdx = -1;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) {
            score += 10 + streak * 5;          // premia matches consecutivos
            if (prevIdx === ti - 1) streak++; else streak = 0;
            if (ti === 0) score += 15;          // premia match al inicio
            prevIdx = ti; qi++;
        }
    }
    return qi === query.length ? score : -1;
}

export class Cmdline {
    private deps: CmdlineDeps;
    private commands: Command[];
    private overlay!: HTMLElement;
    private textEl!: HTMLElement;
    private suggestEl!: HTMLElement;
    private confirmEl!: HTMLElement;
    private promptEl!: HTMLElement;
    private legendEl!: HTMLElement;

    // intent: command palette (`:`) vs card composer (`›`). `cardCapable` is true only
    // when the cmdline was opened as a card composer — it gates the `:`↔Backspace flips
    // so the plain `:` palette keeps behaving exactly as before.
    private intent: "card" | "command" = "command";
    private cardCapable = false;
    private linkTarget: LinkTarget | null = null;

    private open = false;
    private buffer = "";
    private cursor = 0;          // posición del caret dentro de buffer (0..length)
    private freq: Record<string, number>;
    private history: string[];
    private histIdx = -1;        // -1 = buffer en vivo
    private selected = 0;        // índice en la lista de sugerencias
    private matches: Command[] = [];
    private tabBase: string | null = null; // base para ciclar con Tab
    private confirming = false;  // true = diálogo "¿borrar el comando?" abierto
    private draftBuffer = "";    // borrador preservado al cerrar con Escape
    private draftCursor = 0;     // posición del caret del borrador

    // file finder (sigil `/`): activo cuando el cursor está sobre un token de ruta
    private finderActive = false;
    private finderEntries: FinderEntry[] = [];
    private finderSel = 0;
    private finderTok: { start: number; end: number; text: string } | null = null;
    private finderReq = 0;       // id de petición para descartar respuestas viejas

    constructor(deps: CmdlineDeps) {
        this.deps = deps;
        this.freq = loadJSON<Record<string, number>>(FREQ_KEY, {});
        this.history = loadJSON<string[]>(HIST_KEY, []);
        this.commands = this.buildRegistry();
        this.mount();
        window.addEventListener("keydown", (e) => this.onKey(e), true);
    }

    isOpen() { return this.open; }

    /* ─────────── registry: acá vive "cada parte de la app" ─────────── */
    private buildRegistry(): Command[] {
        const views: [string, string][] = [
            ["notes", "all notes"], ["inbox", "unsorted captures"],
            ["daily", "daily journal"], ["projects", "project notes"],
            ["snippets", "code snippets"], ["archive", "archived notes"],
            ["tags", "browse tags"], ["search", "full-text search"]
        ];
        const cmds: Command[] = views.map(([id, hint]) => ({
            id, hint, group: "view" as const,
            run: () => this.deps.setView(id)
        }));

        cmds.push(
            { id: "timeline", aliases: ["cards", "tl"], hint: "card timeline (primary surface)", group: "view",
              run: () => this.deps.showTimeline() },
            { id: "doc", aliases: ["note"], hint: "open the active note as a doc", group: "view",
              run: () => this.deps.openActiveDoc() },
            { id: "new", aliases: ["write", "n"], hint: "compose a new note", group: "app",
              run: () => this.deps.setView("__insert__") },
            { id: "tag", hint: "filter by tag — :tag <name>", group: "tag", takesArg: true,
              run: ({ arg }) => arg ? this.deps.filterTag(arg) : this.deps.setView("tags") },
            { id: "goto", aliases: ["g"], hint: "jump to note N — :goto <n>", group: "note", takesArg: true,
              run: ({ arg, notify }) => {
                  const n = parseInt(arg, 10);
                  if (Number.isFinite(n)) this.deps.jumpToNote(n);
                  else notify("goto: número inválido");
              } },
            { id: "theme", hint: "toggle light/dark", group: "app",
              run: () => this.deps.toggleTheme() },
            { id: "reload", aliases: ["r"], hint: "re-read notes from disk", group: "app",
              run: () => this.deps.reloadNotes() },
            { id: "anchor", aliases: ["a"], hint: "anchor active note to code — :anchor <file> <lines>", group: "note", takesArg: true,
              run: ({ arg, notify }) => {
                  const parts = arg.trim().split(/\s+/).filter(Boolean);
                  if (parts.length < 2) { notify("uso: :anchor <archivo> <líneas>  (ej: :anchor noteservice.go 166-195)"); return; }
                  const lines = parts.pop() as string;
                  const file = parts.join(" ");
                  this.deps.addAnchor(file, lines);
              } },
            { id: "edit", aliases: ["e"], hint: "open file/folder — :e <path>", group: "fs", takesArg: true,
              run: ({ arg }) => this.deps.runFs("e", arg) },
            { id: "cd", hint: "change directory — :cd <path>", group: "fs", takesArg: true,
              run: ({ arg }) => this.deps.runFs("cd", arg) },
            { id: "help", aliases: ["h", "?", "guia", "welcome"], hint: "abrir la guía / welcome", group: "app",
              run: () => this.deps.showHelp() }
        );
        return cmds;
    }

    /* ─────────── DOM ─────────── */
    private mount() {
        this.overlay = document.getElementById("cmdlineOverlay")!;
        this.textEl = document.getElementById("clText")!;
        this.suggestEl = document.getElementById("clSuggest")!;
        this.confirmEl = document.getElementById("clConfirm")!;
        this.promptEl = document.getElementById("clPrompt")!;
        this.legendEl = document.getElementById("clLegend")!;
    }

    /* ─────────── ciclo de vida ─────────── */
    show(opts: CmdlineShowOpts = {}) {
        this.open = true;
        this.intent = opts.intent ?? "command";
        this.cardCapable = this.intent === "card";
        this.linkTarget = opts.linkTarget ?? null;
        if (this.intent === "card") {
            // el compositor de tarjetas arranca limpio; los borradores son del palette
            this.buffer = "";
            this.cursor = 0;
        } else {
            // restaurar borrador (texto + posición del cursor) si quedó algo de antes
            this.buffer = this.draftBuffer;
            this.cursor = Math.min(this.draftCursor, this.buffer.length);
        }
        this.histIdx = -1;
        this.tabBase = null;
        this.confirming = false;
        this.overlay.hidden = false;
        this.overlay.classList.add("visible");
        this.render();
    }
    /* Cierra el overlay. Por defecto preserva el borrador (Escape); al ejecutar
       un comando se limpia con clearDraft() antes de cerrar. */
    private hide() {
        // only the command palette keeps a draft; card-composer text must never bleed
        // into the next plain `:` palette (it would run as a bogus command on Enter).
        if (this.intent === "command") {
            this.draftBuffer = this.buffer;
            this.draftCursor = this.cursor;
        }
        this.confirming = false;
        this.confirmEl.hidden = true;
        this.open = false;
        this.overlay.classList.remove("visible");
        this.overlay.hidden = true;
    }
    private clearDraft() {
        this.buffer = ""; this.cursor = 0;
        this.draftBuffer = ""; this.draftCursor = 0;
    }

    /* flip between the card composer and the command palette in-session (`:`/Backspace).
       Always lands on an empty buffer, mirroring the concept's two-mode overlay. */
    private flipIntent(to: "card" | "command") {
        this.intent = to;
        this.buffer = "";
        this.cursor = 0;
        this.selected = 0;
        this.tabBase = null;
        this.histIdx = -1;
        this.render();
    }

    /* ─────────── teclado ─────────── */
    private onKey(e: KeyboardEvent) {
        if (!this.open) return;
        // mientras la cmdline está abierta, ella consume todo
        e.preventDefault();
        e.stopPropagation();

        // diálogo de confirmación de borrado total: Enter borra, lo demás cancela
        if (this.confirming) {
            if (e.key === "Enter") { this.clearDraft(); this.tabBase = null; this.histIdx = -1; }
            this.confirming = false;
            this.confirmEl.hidden = true;
            this.render();
            return;
        }

        // Ctrl+Backspace → abrir confirmación para borrar todo el comando
        if (e.key === "Backspace" && (e.ctrlKey || e.metaKey)) {
            if (this.buffer.length) { this.confirming = true; this.renderConfirm(); }
            return;
        }

        // finder de archivos activo: ↑/↓ navega, Tab/⏎ completa la ruta
        if (this.finderActive && this.finderEntries.length) {
            switch (e.key) {
                case "ArrowDown": this.moveFinder(1); return;
                case "ArrowUp": this.moveFinder(-1); return;
                case "Tab": this.completeFinder(); return;
                case "Enter": this.completeFinder(); return;
                // Escape, edición y movimiento de cursor caen al switch normal
            }
        }

        // card composer: `:` on an empty buffer flips to the command palette
        if (this.intent === "card" && e.key === ":" && this.buffer === "") {
            this.flipIntent("command");
            return;
        }
        // command palette opened FROM the composer: Backspace on an empty buffer flips back
        if (this.intent === "command" && this.cardCapable && e.key === "Backspace" && this.buffer === "") {
            this.flipIntent("card");
            return;
        }

        switch (e.key) {
            case "Escape": this.hide(); return;        // preserva borrador + cursor
            case "Enter": this.execute(); return;
            case "Backspace":
                if (this.cursor > 0) {
                    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
                    this.cursor--;
                }
                this.tabBase = null;
                break;
            case "Delete":
                if (this.cursor < this.buffer.length) {
                    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
                }
                this.tabBase = null;
                break;
            case "ArrowLeft": if (this.cursor > 0) this.cursor--; this.render(true); return;
            case "ArrowRight": if (this.cursor < this.buffer.length) this.cursor++; this.render(true); return;
            case "Home": this.cursor = 0; this.render(true); return;
            case "End": this.cursor = this.buffer.length; this.render(true); return;
            case "Tab": if (this.intent !== "card") this.complete(e.shiftKey ? -1 : 1); return;
            case "ArrowDown": if (this.intent !== "card") this.moveSel(1); return;
            case "ArrowUp":
                if (this.intent === "card") return;
                this.histIdx === -1 && this.matches.length > 1 ? this.moveSel(-1) : this.historyPrev();
                return;
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    this.buffer = this.buffer.slice(0, this.cursor) + e.key + this.buffer.slice(this.cursor);
                    this.cursor++;
                    this.tabBase = null;
                } else return;
        }
        this.histIdx = -1;
        this.render();
    }

    private renderConfirm() {
        this.confirmEl.innerHTML =
            `<div class="cl-confirm-box">` +
            `<span class="cl-confirm-q">¿borrar todo el comando?</span>` +
            `<span class="cl-confirm-hint"><kbd>⏎</kbd> borrar · cualquier otra tecla cancela</span>` +
            `</div>`;
        this.confirmEl.hidden = false;
    }

    private historyPrev() {
        if (!this.history.length) return;
        this.histIdx = Math.min(this.histIdx + 1, this.history.length - 1);
        this.buffer = this.history[this.history.length - 1 - this.histIdx] ?? this.buffer;
        this.cursor = this.buffer.length;
        this.render();
    }

    private moveSel(delta: number) {
        if (!this.matches.length) return;
        this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
        this.renderSuggest();
    }

    /* Tab: completa al match seleccionado; Tab repetido cicla */
    private complete(dir: number) {
        if (!this.matches.length) return;
        if (this.tabBase === null) this.tabBase = this.buffer;
        this.selected = (this.selected + dir + this.matches.length) % this.matches.length;
        this.buffer = this.matches[this.selected].id + " ";
        this.cursor = this.buffer.length;
        this.render(true); // preservar selección
    }

    /* ─────────── matching ─────────── */
    private computeMatches() {
        const [head] = this.buffer.trim().split(/\s+/, 1);
        const q = head ?? "";
        const scored: { c: Command; s: number }[] = [];
        for (const c of this.commands) {
            const names = [c.id, ...(c.aliases ?? [])];
            let best = -1;
            for (const nm of names) best = Math.max(best, fuzzy(q, nm));
            if (best >= 0) scored.push({ c, s: best + (this.freq[c.id] ?? 0) * 4 });
        }
        scored.sort((a, b) => b.s - a.s);
        this.matches = scored.map(x => x.c);
        if (this.selected >= this.matches.length) this.selected = 0;
    }

    /* ─────────── ejecución ─────────── */
    private execute() {
        if (this.intent === "card") { this.submitCard(); return; }

        const raw = this.buffer.trim();
        if (!raw) { this.clearDraft(); this.hide(); return; }

        // `*…` is a multi-field new-note statement, not a registry command.
        if (raw.startsWith("*")) {
            this.history = [...this.history.filter(h => h !== raw), raw].slice(-50);
            saveJSON(HIST_KEY, this.history);
            const st = parseStatement(raw);
            this.clearDraft();
            this.hide();
            this.deps.createNoteFull(st);
            return;
        }

        const [head, ...rest] = raw.split(/\s+/);
        const arg = rest.join(" ");
        const cmd = this.matches[0] && this.matches[0].id.startsWith(head)
            ? this.matches[0]
            : this.commands.find(c => c.id === head || (c.aliases ?? []).includes(head));

        // historial
        this.history = [...this.history.filter(h => h !== raw), raw].slice(-50);
        saveJSON(HIST_KEY, this.history);

        if (!cmd) { this.deps.notify(`:${head} no es un comando`); this.clearDraft(); this.hide(); return; }
        this.freq[cmd.id] = (this.freq[cmd.id] ?? 0) + 1;
        saveJSON(FREQ_KEY, this.freq);

        this.clearDraft();
        this.hide();
        cmd.run({ arg, notify: this.deps.notify });
    }

    /* card composer Enter: parse the body + inline tokens and mint a card. */
    private submitCard() {
        const { body, tags } = parseCardInput(this.buffer);
        if (!body) { this.deps.notify("tarjeta vacía"); return; }
        const link = this.linkTarget;
        this.clearDraft();
        this.hide();
        this.deps.createCard(body, tags, link ? link.id : null, link ? link.kind : "");
    }

    /* ─────────── render ─────────── */
    private render(keepSel = false) {
        if (!keepSel) this.selected = 0;
        this.updateChrome();
        this.renderBuffer();
        if (this.intent === "card") {
            this.finderActive = false;
            this.finderEntries = [];
            this.matches = [];
            this.renderCardPreview();
            return;
        }
        if (this.buffer.trim().startsWith("*")) {
            this.matches = [];
            // si el cursor está sobre un token de ruta → finder de archivos
            const tok = this.pathTokenAtCursor();
            if (tok) { this.startFinder(tok); return; }
            this.finderActive = false;
            this.finderEntries = [];
            this.renderStatementPreview();
            return;
        }
        this.finderActive = false;
        this.computeMatches();
        this.renderSuggest();
    }

    /* prompt symbol + legend follow the intent (`›` card composer / `:` palette). */
    private updateChrome() {
        if (this.intent === "card") {
            this.promptEl.textContent = "›";
            this.legendEl.textContent = this.linkTarget ? "Link · nueva tarjeta" : "Nueva tarjeta";
        } else {
            this.promptEl.textContent = ":";
            this.legendEl.textContent = "Cmdline";
        }
    }

    /* live preview of the card being composed, rendered with the real card builder so
       the composer shows exactly what the timeline will. */
    private renderCardPreview() {
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const { body, tags } = parseCardInput(this.buffer);
        if (!body) {
            const hint = this.linkTarget
                ? `respondiendo a #${esc(this.linkTarget.shortId)} — escribí la tarjeta…`
                : "escribí <b>tags : cuerpo</b> &nbsp;·&nbsp; ej: <kbd>fix done : el bug ya está</kbd> &nbsp;·&nbsp; <kbd>:</kbd> comandos";
            this.suggestEl.innerHTML = `<li class="cl-empty">${hint}</li>`;
            return;
        }
        const vm = previewVM(body, tags, this.linkTarget);
        const card = buildCardEl(vm, {
            mode: "preview",
            refTarget: this.linkTarget ? linkTargetVM(this.linkTarget) : null,
        });
        const li = document.createElement("li");
        li.className = "cl-card-preview";
        const label = document.createElement("div");
        label.className = "cl-prev-label";
        label.textContent = "vista previa";
        li.appendChild(label);
        li.appendChild(card);
        this.suggestEl.replaceChildren(li);
    }

    /* ─────────── finder de archivos (sigil `/`) ─────────── */
    // Devuelve el token de ruta que rodea al cursor, o null. Un token de ruta
    // empieza con `/`, `~/` o `./` y aún no tiene `:` (sin líneas/marcador todavía).
    private pathTokenAtCursor(): { start: number; end: number; text: string } | null {
        const b = this.buffer;
        const isSep = (ch: string) => ch === "*" || ch === "#" || ch === ";" || /\s/.test(ch);
        let start = this.cursor;
        while (start > 0 && !isSep(b[start - 1])) start--;
        let end = this.cursor;
        while (end < b.length && !isSep(b[end])) end++;
        const text = b.slice(start, end);
        if (!/^(~\/|\.\/|\/)/.test(text)) return null;
        if (text.includes(":")) return null; // ya está eligiendo líneas/marcador
        return { start, end, text };
    }

    private startFinder(tok: { start: number; end: number; text: string }) {
        this.finderActive = true;
        this.finderTok = tok;
        const req = ++this.finderReq;
        // pinta de inmediato lo que ya teníamos para que no parpadee
        this.renderFinder();
        this.deps.listDir(tok.text).then((entries) => {
            if (req !== this.finderReq || !this.finderActive) return; // respuesta vieja
            this.finderEntries = entries;
            this.finderSel = 0;
            this.renderFinder();
        }).catch(() => { /* finder silencioso */ });
    }

    private moveFinder(delta: number) {
        if (!this.finderEntries.length) return;
        const n = this.finderEntries.length;
        this.finderSel = (this.finderSel + delta + n) % n;
        this.renderFinder();
    }

    // Completa la ruta con la entrada seleccionada. Carpeta → agrega `/` y sigue
    // navegando; archivo → agrega `:` para que escribas líneas o marcador a continuación.
    private completeFinder() {
        const tok = this.finderTok;
        const sel = this.finderEntries[this.finderSel];
        if (!tok || !sel) return;
        const lastSlash = tok.text.lastIndexOf("/");
        const prefix = tok.text.slice(0, lastSlash + 1);     // hasta el último `/`
        const newTok = prefix + sel.name + (sel.isDir ? "/" : ":");
        this.buffer = this.buffer.slice(0, tok.start) + newTok + this.buffer.slice(tok.end);
        this.cursor = tok.start + newTok.length;
        this.render(true);
    }

    private renderFinder() {
        const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (!this.finderEntries.length) {
            this.suggestEl.innerHTML = `<li class="cl-empty">sin archivos</li>`;
            return;
        }
        this.suggestEl.innerHTML = this.finderEntries.slice(0, 60).map((e, i) => `
            <li class="cl-file ${i === this.finderSel ? "sel" : ""}">
                <span class="cl-file-ico cl-file-${e.isDir ? "dir" : "file"}">${e.isDir ? "▸" : "·"}</span>
                <span class="cl-file-name">${esc(e.name)}${e.isDir ? "/" : ""}</span>
            </li>`).join("");
    }

    /* Dibuja el buffer con un caret de bloque en la posición del cursor.
       El caret va "encima" del carácter en this.cursor (o al final si está al borde). */
    private renderBuffer() {
        const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const b = this.buffer;
        const c = Math.min(this.cursor, b.length);
        const before = esc(b.slice(0, c));
        const atRaw = b.slice(c, c + 1);
        const after = esc(b.slice(c + 1));
        // un espacio (nbsp) cuando el caret está al final, para que el bloque se vea
        const at = atRaw ? esc(atRaw) : "\u00A0";
        this.textEl.innerHTML =
            `${before}<span class="cl-caret">${at}</span>${after}`;
    }

    /* Preview en vivo de un statement `:*` — la etapa "Preview" del parser. */
    private renderStatementPreview() {
        const st = parseStatement(this.buffer);
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const chip = (cls: string, txt: string) => `<span class="cl-chip cl-chip-${cls}">${esc(txt)}</span>`;
        const parts: string[] = [];
        parts.push(chip("title", st.title || "untitled"));
        if (st.status) parts.push(chip("status", st.status));
        if (st.priority) parts.push(chip("prio", st.priority));
        // tags: sin `+`, color por convención (bug=rojo…), el sigil se ve al hacer hover.
        st.tags.forEach((t) => {
            const col = tagColor(t);
            parts.push(
                `<span class="cl-chip cl-chip-tag" title="+${esc(t)}" ` +
                `style="--tc:${col};color:${col};border-color:${col}55">${esc(t)}</span>`);
        });
        st.people.forEach((p) => parts.push(chip("person", "@" + p)));
        st.anchors.forEach((a) => parts.push(chip("anchor", `⚓ ${a.file}:${a.lines}`)));
        const body = st.body ? `<div class="cl-prev-body">${esc(st.body)}</div>` : "";
        const warn = st.warnings.length
            ? `<div class="cl-prev-warn">⚠ no reconocido: ${st.warnings.map(esc).join(", ")}</div>` : "";
        this.suggestEl.innerHTML =
            `<li class="cl-preview"><div class="cl-prev-chips">${parts.join("")}</div>${body}${warn}</li>`;
    }

    private renderSuggest() {
        const groupLabel: Record<Command["group"], string> = {
            view: "view", note: "note", tag: "tag", app: "app", fs: "fs"
        };
        this.suggestEl.innerHTML = this.matches.slice(0, 8).map((c, i) => `
            <li class="cl-item ${i === this.selected ? "sel" : ""}">
                <span class="cl-name">:${c.id}</span>
                <span class="cl-grp cl-grp-${c.group}">${groupLabel[c.group]}</span>
                <span class="cl-hint-txt">${c.hint}</span>
                ${this.freq[c.id] ? `<span class="cl-freq">×${this.freq[c.id]}</span>` : ""}
            </li>`).join("") || `<li class="cl-empty">sin coincidencias</li>`;
    }
}
