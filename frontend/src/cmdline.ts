/* ───────────────────────────── noteit · cmdline ─────────────────────────────
   nvim-style command line. Se abre con `:` y deja alcanzar CUALQUIER parte de
   la app escribiendo. Incluye:
     · registry extensible de comandos (cada vista/acción es un comando)
     · fuzzy matching
     · Tab para autocompletar (cicla entre matches)
     · historial (↑/↓) y ranking por frecuencia (persistido en localStorage)
     · cursor de bloque estilo nvim (buffer manejado, no <input>)
   La navegación real del filesystem necesita una binding de Go (ver runFs). */

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
}

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
    private overlay: HTMLElement;
    private textEl: HTMLElement;
    private suggestEl: HTMLElement;

    private open = false;
    private buffer = "";
    private freq: Record<string, number>;
    private history: string[];
    private histIdx = -1;        // -1 = buffer en vivo
    private selected = 0;        // índice en la lista de sugerencias
    private matches: Command[] = [];
    private tabBase: string | null = null; // base para ciclar con Tab

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
            { id: "edit", aliases: ["e"], hint: "open file/folder — :e <path>", group: "fs", takesArg: true,
              run: ({ arg }) => this.deps.runFs("e", arg) },
            { id: "cd", hint: "change directory — :cd <path>", group: "fs", takesArg: true,
              run: ({ arg }) => this.deps.runFs("cd", arg) },
            { id: "help", aliases: ["h", "?"], hint: "command reference", group: "app",
              run: ({ notify }) => notify("comandos: " + this.commands.map(c => ":" + c.id).join("  ")) }
        );
        return cmds;
    }

    /* ─────────── DOM ─────────── */
    private mount() {
        this.overlay = document.getElementById("cmdlineOverlay")!;
        this.textEl = document.getElementById("clText")!;
        this.suggestEl = document.getElementById("clSuggest")!;
    }

    /* ─────────── ciclo de vida ─────────── */
    show() {
        this.open = true;
        this.buffer = "";
        this.histIdx = -1;
        this.tabBase = null;
        this.overlay.hidden = false;
        this.overlay.classList.add("visible");
        this.render();
    }
    hide() {
        this.open = false;
        this.overlay.classList.remove("visible");
        this.overlay.hidden = true;
    }

    /* ─────────── teclado ─────────── */
    private onKey(e: KeyboardEvent) {
        if (!this.open) return;
        // mientras la cmdline está abierta, ella consume todo
        e.preventDefault();
        e.stopPropagation();

        switch (e.key) {
            case "Escape": this.hide(); return;
            case "Enter": this.execute(); return;
            case "Backspace": this.buffer = this.buffer.slice(0, -1); this.tabBase = null; break;
            case "Tab": this.complete(e.shiftKey ? -1 : 1); return;
            case "ArrowDown": this.moveSel(1); return;
            case "ArrowUp": this.histIdx === -1 && this.matches.length > 1 ? this.moveSel(-1) : this.historyPrev(); return;
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { this.buffer += e.key; this.tabBase = null; }
                else return;
        }
        this.histIdx = -1;
        this.render();
    }

    private historyPrev() {
        if (!this.history.length) return;
        this.histIdx = Math.min(this.histIdx + 1, this.history.length - 1);
        this.buffer = this.history[this.history.length - 1 - this.histIdx] ?? this.buffer;
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
        const raw = this.buffer.trim();
        if (!raw) { this.hide(); return; }
        const [head, ...rest] = raw.split(/\s+/);
        const arg = rest.join(" ");
        const cmd = this.matches[0] && this.matches[0].id.startsWith(head)
            ? this.matches[0]
            : this.commands.find(c => c.id === head || (c.aliases ?? []).includes(head));

        // historial
        this.history = [...this.history.filter(h => h !== raw), raw].slice(-50);
        saveJSON(HIST_KEY, this.history);

        if (!cmd) { this.deps.notify(`:${head} no es un comando`); this.hide(); return; }
        this.freq[cmd.id] = (this.freq[cmd.id] ?? 0) + 1;
        saveJSON(FREQ_KEY, this.freq);

        this.hide();
        cmd.run({ arg, notify: this.deps.notify });
    }

    /* ─────────── render ─────────── */
    private render(keepSel = false) {
        if (!keepSel) this.selected = 0;
        this.computeMatches();
        // cursor de bloque nvim: bloque sólido al final del buffer
        this.textEl.textContent = this.buffer;
        this.renderSuggest();
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
