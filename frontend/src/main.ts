import "./style.css";
import { Cmdline } from "./cmdline.js";

console.log("%cnoteit", "color:#5ef3a8;font-weight:700;font-size:16px");
console.log("frontend booted — wails v3 + vanilla ts (sketch shell)");

/* ───────────────────────── Note deck (sketch data) ───────────────────────── */
interface Note { when: string; who: string; title: string; color: string; bodyHtml?: string; }

const NOTES: Note[] = [
    {
        when: "2025-05-20  14:37", who: "alex@local",
        title: "Refactor: Async Resource Pool", color: "#e3b341",
        bodyHtml: `<pre class="code"><code><span class="k">class</span> <span class="t">Pool</span>&lt;T&gt; {
  <span class="k">private</span> idle: T[] = []
  <span class="k">private</span> busy = <span class="k">new</span> <span class="t">Set</span>&lt;T&gt;()
  <span class="t">constructor</span>(<span class="k">private</span> factory: () =&gt; <span class="t">Promise</span>&lt;T&gt;, <span class="k">private</span> size: <span class="t">number</span>) {}

  <span class="k">async</span> acquire(): <span class="t">Promise</span>&lt;T&gt; {
    <span class="k">if</span> (<span class="k">this</span>.idle.length) <span class="k">return</span> <span class="k">this</span>.idle.pop()!
    <span class="k">if</span> (<span class="k">this</span>.busy.size &lt; <span class="k">this</span>.size) {
      <span class="k">const</span> resource = <span class="k">await</span> <span class="k">this</span>.factory()
      <span class="k">this</span>.busy.add(resource)
      <span class="k">return</span> resource
    }
    <span class="k">await</span> <span class="k">this</span>.waitForRelease()
    <span class="k">return</span> <span class="k">this</span>.acquire()
  }
}</code></pre>
<p class="card-foot"><span class="cmt">// Reduced tail latency ~18% under high contention.</span></p>`
    },
    { when: "2025-05-20  10:12", who: "alex@local", title: "Git: Rewrite history safely", color: "#5ef3a8" },
    { when: "2025-05-19  21:48", who: "alex@local", title: "Neovim: My minimal init.lua", color: "#f0883e" },
    { when: "2025-05-19  16:05", who: "alex@local", title: "Postgres: Partial index gotcha", color: "#39c5cf" },
    { when: "2025-05-18  11:30", who: "alex@local", title: "Thinking in Types > Comments", color: "#f85149" },
    { when: "2025-05-17  09:02", who: "alex@local", title: "jq one-liners I keep forgetting", color: "#6b7686" }
];

const deck = document.getElementById("deck")!;
const cmdbar = document.getElementById("cmdbar")!;
const cmdInput = document.getElementById("cmdInput") as HTMLInputElement;
const modeEl = document.getElementById("mode")!;
const barCaret = document.getElementById("barCaret")!;
const barMirror = document.getElementById("barMirror")!;
const toastEl = document.getElementById("toast")!;

let active = 0;

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function expandedCard(n: Note) {
    return `<div class="card-meta">
            <span class="when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
            <span class="who">${escHtml(n.who)}</span>
        </div>
        <h2 class="card-title">${escHtml(n.title)}</h2>
        ${n.bodyHtml ?? `<p class="card-body">${escHtml(n.title)} — nota vacía (sketch).</p>`}`;
}
function collapsedCard(n: Note) {
    return `<span class="row-when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
        <span class="row-title">${escHtml(n.title)}</span>
        <span class="row-who">${escHtml(n.who)}</span>`;
}
function render() {
    deck.innerHTML = "";
    NOTES.forEach((n, i) => {
        const card = document.createElement("article");
        card.className = "card " + (i === active ? "is-active" : "collapsed");
        card.innerHTML = i === active ? expandedCard(n) : collapsedCard(n);
        card.addEventListener("click", () => { active = i; render(); });
        deck.appendChild(card);
    });
    deck.children[active]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function move(delta: number) { active = (active + delta + NOTES.length) % NOTES.length; render(); }

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
    // mide el ancho del texto actual con un mirror y posiciona el bloque
    barMirror.textContent = cmdInput.value || "";
    const w = barMirror.getBoundingClientRect().width;
    barCaret.style.left = `${w}px`;
}

/* ───────────────────────── Sidebar / views ───────────────────────── */
function setView(view: string) {
    if (view === "__insert__") { setMode("insert"); notify("✎ new note"); return; }
    document.querySelectorAll<HTMLElement>(".nav-item").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.view === view);
    });
    notify(`→ ${view}`);
}
document.querySelectorAll<HTMLElement>(".nav-item").forEach((el) => {
    el.addEventListener("click", () => el.dataset.view && setView(el.dataset.view));
});

function filterTag(tag: string) {
    const exists = Array.from(document.querySelectorAll(".tag-item .lbl")).some(
        (e) => e.textContent === tag
    );
    notify(exists ? `# filtrando por tag: ${tag}` : `# tag "${tag}" no existe`);
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
    // TODO: invocar GreetService/FsService.List(path) cuando exista la binding.
    notify(`:${op} ${path} — binding Go pendiente`);
}

/* ───────────────────────── Cmdline ───────────────────────── */
const cmdline = new Cmdline({
    setView,
    jumpToNote: (n1) => {
        const idx = Math.min(Math.max(n1, 1), NOTES.length) - 1;
        active = idx; render(); notify(`↪ note ${idx + 1}`);
    },
    noteCount: () => NOTES.length,
    filterTag,
    listTags: () => Array.from(document.querySelectorAll(".tag-item .lbl")).map((e) => e.textContent ?? ""),
    toggleTheme,
    notify,
    runFs
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
    if (cmdline.isOpen()) return; // la cmdline consume sus propias teclas

    // `:` abre la cmdline desde NORMAL (en INSERT es texto literal)
    if (ev.key === ":" && mode === "normal") { ev.preventDefault(); cmdline.show(); return; }

    if (ev.key === "Escape") { setMode("normal"); return; }

    if (mode === "normal") {
        if (ev.key === "j" || ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
        else if (ev.key === "k" || ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
        else if (ev.key === "i" || ev.key === "a") { setMode("insert"); ev.preventDefault(); }
        else if (ev.key === "g") { active = 0; render(); ev.preventDefault(); }
        else if (ev.key === "G") { active = NOTES.length - 1; render(); ev.preventDefault(); }
        return;
    }

    // INSERT: ↑/↓ siguen navegando el deck
    if (ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
});

render();
setMode("insert");
updateBarCaret();
