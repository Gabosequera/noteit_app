/* ───────────────────────────── noteit · welcome / guía ─────────────────────────────
   A persistent, always-reachable help page. It is NOT a transient toast — it is a full
   overlay you can open any time (tools `?` button, the `?` key, or `:help`) and read at
   leisure, then dismiss with Escape. Content is built ONCE from the live taxonomy mirror
   (so the axes/tags list can never drift from what the composer actually resolves) plus a
   static description of commands, shortcuts and where data is stored.

   The page owns its own capture-phase key handler (Escape/?/q close it) so it works no
   matter which surface is underneath, mirroring how the cmdline overlay behaves. */

import { TAXONOMY } from "./cards/taxonomy.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kbd = (k: string) => `<kbd>${esc(k)}</kbd>`;

/* where the vault lives on disk (relative to the project root that contains .git). */
const CARDS_PATH = ".noteit/timeline.md";
const NOTES_PATH = ".noteit/notes/<uuid>.md";

export class HelpPage {
    private overlay: HTMLElement;
    private body: HTMLElement;
    private built = false;
    private isOpen = false;

    constructor() {
        this.overlay = document.getElementById("helpOverlay")!;
        this.body = document.getElementById("helpBody")!;
        document.getElementById("helpClose")?.addEventListener("click", () => this.hide());
        // click on the dim backdrop (not the panel) closes
        this.overlay.addEventListener("click", (e) => { if (e.target === this.overlay) this.hide(); });
        // capture key handling so it wins over the app dispatcher while open
        window.addEventListener("keydown", (e) => this.onKey(e), true);
    }

    open() { return this.isOpen; }

    show() {
        if (!this.built) { this.body.innerHTML = this.render(); this.built = true; }
        this.isOpen = true;
        this.overlay.hidden = false;
        this.overlay.classList.add("visible");
        this.body.scrollTop = 0;
    }
    hide() {
        this.isOpen = false;
        this.overlay.classList.remove("visible");
        this.overlay.hidden = true;
    }
    toggle() { this.isOpen ? this.hide() : this.show(); }

    private onKey(e: KeyboardEvent) {
        if (!this.isOpen) return;
        if (e.key === "Escape" || e.key === "q" || e.key === "?") {
            e.preventDefault(); e.stopPropagation();
            this.hide();
        }
    }

    /* ─────────── content ─────────── */
    private render(): string {
        return [
            this.intro(),
            this.creatingCards(),
            this.grammar(),
            this.axes(),
            this.commands(),
            this.shortcuts(),
            this.storage(),
        ].join("");
    }

    private section(title: string, inner: string): string {
        return `<section class="help-sec"><h2 class="help-h2">${esc(title)}</h2>${inner}</section>`;
    }

    private intro(): string {
        return this.section("¿Qué es noteit?", `
            <p class="help-p">Dos superficies, un objetivo: capturar y volver a encontrar.</p>
            <ul class="help-list">
                <li><b>Tarjetas</b> — la <b>línea de tiempo</b> (icono ⏱ arriba en la barra lateral).
                    Cada tarjeta es <b>inmutable</b> y <b>append-only</b>: se crea y queda, como un journal.
                    Es la superficie principal.</li>
                <li><b>Notas / hojas de texto</b> — documentos markdown <b>editables</b> con vim real
                    (los archivos que ves listados en la barra lateral). Acá escribís libre y podés
                    <b>embeber tarjetas</b> con la línea <code>!card[&lt;uuid&gt;]</code>.</li>
            </ul>`);
    }

    private creatingCards(): string {
        return this.section("Crear una tarjeta", `
            <p class="help-p">Parado en la <b>timeline</b> (clic en ⏱ <b>timeline</b>), abrí el compositor con:</p>
            <ul class="help-list">
                <li>${kbd("i")} o ${kbd("o")} — compositor de tarjeta</li>
                <li>${kbd("+")} (botón de la barra lateral, cuando estás en la timeline)</li>
                <li>${kbd(":")} — abre la cmdline; ${kbd("Backspace")} en vacío vuelve al compositor</li>
                <li>${kbd("espacio")} ${kbd("c")} — atajo "nueva tarjeta" desde cualquier lado</li>
            </ul>
            <p class="help-p">En el compositor (prompt <code>›</code>) escribís y ves una <b>vista previa en vivo</b>.
            ${kbd("⏎")} la crea. Para <b>enlazar/anidar</b>: ${kbd("l")} (link hermano) o ${kbd("p")} (hija) sobre una tarjeta.</p>`);
    }

    private grammar(): string {
        return this.section("Gramática: tags : cuerpo", `
            <p class="help-p">Todo lo que va <b>antes del primer <code>:</code></b> son los <b>tags</b>
            (palabras sueltas, separadas por espacio — <b>sin</b> necesidad de <code>+</code>).
            Todo lo que va <b>después</b> es el <b>cuerpo</b>, tal cual: si escribís otro <code>:</code>
            en el texto, <b>no</b> vuelve a partir (solo cuenta el primero).</p>
            <div class="help-eg">
                <div class="help-eg-in">fix done : el bug del login ya está, validaba mal</div>
                <div class="help-eg-out">→ tags: <span class="hx hx-type">fix</span> <span class="hx hx-status">done</span> · cuerpo: "el bug del login ya está, validaba mal"</div>
            </div>
            <div class="help-eg">
                <div class="help-eg-in">rem p1 backend : revisar timeouts del API</div>
                <div class="help-eg-out">→ <span class="hx hx-type">rem</span> <span class="hx hx-prio">p1</span> <span class="hx hx-area">backend</span> · cuerpo: "revisar timeouts del API"</div>
            </div>
            <p class="help-note">Si no hay <code>:</code> con pinta de sección de tags al inicio (p.ej. una URL
            <code>http://…</code> o código), todo el texto se toma como cuerpo. También seguís pudiendo
            usar sigilos inline <code>+tag</code> / <code>#tag</code> como antes.</p>`);
    }

    private axes(): string {
        const rows = TAXONOMY.map((ax) => {
            const vals = ax.values.map((v) => {
                const syn = v.synonyms.length ? `<span class="help-syn"> (${v.synonyms.map(esc).join(", ")})</span>` : "";
                return `<span class="help-val"><code>${esc(v.canonical)}</code>${syn}</span>`;
            }).join("");
            return `<tr>
                <td class="help-axis"><code>${esc(ax.name)}</code>${ax.multi ? '<span class="help-multi">multi</span>' : ""}</td>
                <td class="help-axis-desc">${esc(ax.desc)}</td>
                <td class="help-vals">${vals}</td>
            </tr>`;
        }).join("");
        return this.section("Los 6 ejes y sus tags", `
            <p class="help-p">Cada tarjeta tiene 6 ejes controlados. Escribís un valor canónico
            <b>o cualquier sinónimo</b> (entre paréntesis) y el backend lo normaliza.
            <code>type</code> y <code>status</code> siempre existen (default <code>note</code> / <code>todo</code>).</p>
            <table class="help-table"><thead><tr><th>eje</th><th>qué es</th><th>valores (sinónimos)</th></tr></thead>
            <tbody>${rows}</tbody></table>`);
    }

    private commands(): string {
        const cmds: [string, string][] = [
            [":timeline", "ir a la línea de tiempo de tarjetas (alias :cards :tl)"],
            [":doc", "abrir la nota activa como hoja de texto (alias :note)"],
            [":new", "redactar una nota nueva (alias :n :write)"],
            [":tag <n>", "filtrar notas por tag"],
            [":goto <n>", "saltar a la nota N (alias :g)"],
            [":anchor <archivo> <líneas>", "anclar la nota activa a código (alias :a)"],
            [":reload", "releer notas del disco (alias :r)"],
            [":theme", "alternar claro/oscuro"],
            [":help", "abrir esta guía (alias :h :?)"],
        ];
        const ex: [string, string][] = [
            [":embed", "insertar la tarjeta cursoreada en la nota (dentro del editor; abrev :emb)"],
            [":timeline", "salir de la nota de vuelta a la timeline (abrev :time)"],
        ];
        const rows = (arr: [string, string][]) => arr.map(([c, d]) =>
            `<tr><td class="help-cmd"><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join("");
        return this.section("Comandos (cmdline :)", `
            <p class="help-p">Abrí la cmdline con ${kbd(":")}. Fuzzy + ${kbd("Tab")} para completar.</p>
            <table class="help-table"><tbody>${rows(cmds)}</tbody></table>
            <p class="help-p">Comandos ex de vim <b>dentro del editor de una nota</b>:</p>
            <table class="help-table"><tbody>${rows(ex)}</tbody></table>`);
    }

    private shortcuts(): string {
        const grp = (title: string, items: [string, string][]) =>
            `<div class="help-keys"><h3 class="help-h3">${esc(title)}</h3>${
                items.map(([k, d]) => `<div class="help-krow">${kbd(k)}<span>${esc(d)}</span></div>`).join("")
            }</div>`;
        return this.section("Atajos de teclado", [
            grp("Timeline (tarjetas)", [
                ["j / k", "bajar / subir el cursor"],
                ["g / G", "primera / última tarjeta"],
                ["i / o", "nueva tarjeta"],
                ["⏎", "abrir el hilo de la tarjeta (foco)"],
                ["l / p", "enlazar hermano / anidar hija"],
            ]),
            grp("Vista de tarjeta (hilo)", [
                ["esc / h / q", "volver a la timeline"],
                ["i / o", "nueva tarjeta"],
                ["l / p", "enlazar / anidar bajo esta tarjeta"],
            ]),
            grp("Editor de notas (vim real)", [
                ["i", "modo inserción (vim)"],
                ["esc", "modo normal"],
                [": (en editor)", "línea ex de vim (:embed, :timeline)"],
                ["ctrl+h / ctrl+l", "salir del editor a otro panel"],
            ]),
            grp("Global", [
                ["espacio", "leader (luego c=tarjeta, n=nota)"],
                [":", "cmdline"],
                ["?", "abrir / cerrar esta guía"],
            ]),
        ].join(""));
    }

    private storage(): string {
        return this.section("¿Dónde se guardan los datos?", `
            <p class="help-p">En la carpeta <code>.noteit/</code> dentro de la raíz del proyecto
            (la carpeta que contiene <code>.git</code>).</p>
            <table class="help-table"><tbody>
                <tr><td class="help-cmd"><b>Tarjetas</b></td><td><code>${esc(CARDS_PATH)}</code> — un solo archivo append-only</td></tr>
                <tr><td class="help-cmd"><b>Notas</b></td><td><code>${esc(NOTES_PATH)}</code> — un archivo por nota</td></tr>
            </tbody></table>
            <p class="help-note">Las tarjetas son <b>inmutables</b>: se agregan al final de <code>timeline.md</code>
            en bloques <code>&gt; CARD … bytes:N</code> / cuerpo / <code>&gt; ENDCARD &lt;id&gt;</code>, con fsync.
            <code>.noteit/.gitignore</code> es <code>*</code>, así que el vault no se commitea por defecto.</p>`);
    }
}
