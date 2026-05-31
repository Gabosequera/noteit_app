import "./style.css";

console.log("%cnoteit", "color:#5ef3a8;font-weight:700;font-size:16px");
console.log("frontend booted — wails v3 + vanilla ts (sketch shell)");

/* ───────────────────────── Note deck (sketch data) ─────────────────────────
   "Ese sistema": las notas son fichas apiladas. La activa se expande, el
   resto quedan colapsadas en el stack. Se navega con j/k o ↑/↓, igual que el
   journal de las ruedas. Datos dummy solo para sketchear el look. */

interface Note {
    when: string;
    who: string;
    title: string;
    color: string;
    bodyHtml?: string; // contenido enriquecido opcional (código, etc.)
}

const NOTES: Note[] = [
    {
        when: "2025-05-20  14:37",
        who: "alex@local",
        title: "Refactor: Async Resource Pool",
        color: "#e3b341",
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

let active = 0;

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function expandedCard(n: Note): string {
    return `
        <div class="card-meta">
            <span class="when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
            <span class="who">${esc(n.who)}</span>
        </div>
        <h2 class="card-title">${esc(n.title)}</h2>
        ${n.bodyHtml ?? `<p class="card-body">${esc(n.title)} — nota vacía (sketch).</p>`}
    `;
}

function collapsedCard(n: Note): string {
    return `
        <span class="row-when"><span class="status" style="--c:${n.color}"></span>${n.when}</span>
        <span class="row-title">${esc(n.title)}</span>
        <span class="row-who">${esc(n.who)}</span>
    `;
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

function move(delta: number) {
    active = (active + delta + NOTES.length) % NOTES.length;
    render();
}

/* ───────────────────────── Modes: INSERT / NORMAL ───────────────────────── */
type Mode = "insert" | "normal";
let mode: Mode = "insert";

function setMode(next: Mode) {
    mode = next;
    cmdbar.classList.toggle("normal", mode === "normal");
    modeEl.textContent = mode === "insert" ? "-- INSERT --" : "-- NORMAL --";
    if (mode === "insert") cmdInput.focus();
    else cmdInput.blur();
}

window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { setMode("normal"); return; }

    if (mode === "normal") {
        if (ev.key === "j" || ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
        else if (ev.key === "k" || ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
        else if (ev.key === "i" || ev.key === "a") { setMode("insert"); ev.preventDefault(); }
        return;
    }

    // En INSERT: ↑/↓ siguen navegando el deck aunque estés escribiendo
    if (ev.key === "ArrowDown") { move(1); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { move(-1); ev.preventDefault(); }
});

render();
setMode("insert");
