/* ───────────────────────────── noteit · statement parser ─────────────────────────────
   Pieza 3. Parsea un comando `:*` en una nota completa, en cualquier orden.

   Sintaxis:
     :*nn*+bug*+fix*medium*inprocess*@gabriel*path/file.go:10-20 #Titulo; cuerpo EOF*+mas-tags

   Reglas:
     · `*` separa los campos de cabecera.
     · `#` empieza el titulo (hasta el proximo `*`, `;` o el final).
     · `;` empieza el cuerpo, que termina en el literal `EOF` (en cualquier lado) o
       al final de la cadena. Tras `EOF` se puede seguir escribiendo campos: `EOF*+tag`.
       El cuerpo no conserva espacios al inicio ni al final.
     · El titulo y el cuerpo pueden ir en cualquier posicion.
     · `+x`  -> tag (texto libre)            · `@x` -> persona
     · `path:10-20` -> ancla al codigo        · palabra cerrada -> estado o prioridad
     · `future`/`next`/`coming`/`missing`/… -> tag canonico `future` (lo que falta
       por implementar y debe venir despues). Con o sin `+`.
     · tags de convencion (bug/fix/refactor/feature/docs/test…) se reconocen aunque
       no lleven `+`, asi podes filtrar por ellos directo.
     · la rama NO se escribe: la rellena el backend desde git.
   Los campos sueltos que no caen en ninguna lista cerrada se reportan como warnings
   en vez de inventar un significado. */

export interface ParsedAnchor { file: string; lines: string; }

export interface ParsedStatement {
    action: string;            // "nn"
    title: string;
    body: string;
    tags: string[];
    people: string[];
    status: string;            // canonico o ""
    priority: string;          // canonico o ""
    anchors: ParsedAnchor[];
    warnings: string[];        // tokens no reconocidos
}

// Vocabularios cerrados: alias (lo que tipeas) -> forma canonica (lo que se guarda).
const STATUS_ALIASES: Record<string, string> = {
    todo: "todo", "to-do": "todo", pendiente: "todo",
    incompleted: "todo", incomplete: "todo",
    working: "working", inprocess: "working", "in-process": "working",
    inprogress: "working", "in-progress": "working", wip: "working",
    haciendo: "working", doing: "working",
    blocked: "blocked", bloqueado: "blocked", stuck: "blocked", failed: "blocked",
    done: "done", hecho: "done", listo: "done",
    completed: "done", ready: "done", closed: "done"
};
const PRIORITY_ALIASES: Record<string, string> = {
    low: "low", lo: "low", baja: "low",
    medium: "medium", med: "medium", mid: "medium", media: "medium",
    high: "high", hi: "high", alta: "high",
    urgent: "high", urgente: "high", emergency: "high", emergencia: "high"
};

/* "future": cosas que faltan / no quedaron implementadas y deben venir despues.
   Todos estos alias se normalizan al tag canonico `future` (color violeta), asi se
   filtran juntos sin importar como los escribas. Funciona con o sin `+`. */
const FUTURE_TAG = "future";
const FUTURE_ALIASES = new Set([
    "future", "next", "coming", "comming", "upcoming",
    "missing", "pending", "later", "soon", "todo-later"
]);
function futureCanonical(word: string): string | null {
    return FUTURE_ALIASES.has(word.toLowerCase()) ? FUTURE_TAG : null;
}

/* Colores por convencion de tag. El color comunica el tipo de trabajo:
   un bug es rojo SIEMPRE, una feature verde, docs azul, etc. El `+` no se
   muestra en el chip (se ve en el tooltip). */
const TAG_COLORS: Record<string, string> = {
    bug: "#f85149", error: "#f85149", broken: "#f85149", fail: "#f85149",
    fix: "#f0883e", hotfix: "#f0883e", patch: "#f0883e",
    feature: "#3fb950", feat: "#3fb950", enhancement: "#3fb950", new: "#3fb950",
    docs: "#58a6ff", doc: "#58a6ff", documentation: "#58a6ff",
    future: "#bc8cff", idea: "#bc8cff", todo: "#bc8cff",
    refactor: "#39c5cf", cleanup: "#39c5cf", chore: "#39c5cf",
    test: "#e3b341", tests: "#e3b341", testing: "#e3b341",
    perf: "#db61a2", performance: "#db61a2", security: "#db61a2"
};
const TAG_DEFAULT_COLOR = "#8b949e"; // neutral para tags fuera de convencion

export function tagColor(tag: string): string {
    return TAG_COLORS[tag.toLowerCase()] ?? TAG_DEFAULT_COLOR;
}

// Un token es ancla si trae `:<lineas>` al final, o parece una ruta (tiene `/`).
function looksLikeAnchor(t: string): boolean {
    return /:\d+(?:-\d+)?$/.test(t) || t.includes("/");
}

function parseAnchor(t: string): ParsedAnchor | null {
    const m = t.match(/^(.+):(\d+(?:-\d+)?)$/);
    if (!m) return null;                 // ruta sin lineas -> no es un ancla valida (Nivel A)
    return { file: m[1], lines: m[2] };
}

// raw = lo que hay despues de los dos puntos. Empieza con `*`.
export function parseStatement(raw: string): ParsedStatement {
    const out: ParsedStatement = {
        action: "", title: "", body: "", tags: [], people: [],
        status: "", priority: "", anchors: [], warnings: []
    };

    const s = raw;
    let i = 0;
    const n = s.length;

    // soltar espacios y el marcador `*` inicial
    while (i < n && /\s/.test(s[i])) i++;
    if (i < n && s[i] === "*") i++;

    const tokens: string[] = []; // campos de cabecera, en orden de aparicion

    while (i < n) {
        const ch = s[i];

        if (ch === "*") { i++; continue; }          // separador de campos

        if (ch === ";") {                            // cuerpo: hasta EOF o fin
            i++;
            const start = i;
            const eof = s.indexOf("EOF", i);
            const end = eof >= 0 ? eof : n;
            out.body = s.slice(start, end).trim();   // sin espacios al inicio ni al final
            i = eof >= 0 ? eof + 3 : n;              // tras EOF se sigue parseando
            continue;
        }

        if (ch === "#") {                            // titulo: hasta `*`, `;` o fin
            i++;
            const start = i;
            while (i < n && s[i] !== "*" && s[i] !== ";") i++;
            out.title = s.slice(start, i).trim();
            continue;
        }

        // campo normal: hasta `*`, `;`, `#` o fin
        const start = i;
        while (i < n && s[i] !== "*" && s[i] !== ";" && s[i] !== "#") i++;
        const tok = s.slice(start, i).trim();
        if (tok) tokens.push(tok);
    }

    for (const t of tokens) {
        if (t === "nn" || t === "newnote") { out.action = "nn"; continue; }
        // `+x` -> tag explicito. Si es de la familia "future", se normaliza a `future`.
        if (t.startsWith("+")) {
            const v = t.slice(1).trim();
            if (v) out.tags.push(futureCanonical(v) ?? v);
            continue;
        }
        if (t.startsWith("@")) { const v = t.slice(1).trim(); if (v) out.people.push(v); continue; }
        if (looksLikeAnchor(t)) {
            const a = parseAnchor(t);
            if (a) out.anchors.push(a);
            else out.warnings.push(`ancla sin lineas: ${t}`);
            continue;
        }
        const lower = t.toLowerCase();
        // future-family sin `+` (future/next/coming/missing…) -> tag `future`
        const fut = futureCanonical(lower);
        if (fut) { out.tags.push(fut); continue; }
        if (STATUS_ALIASES[lower]) { out.status = STATUS_ALIASES[lower]; continue; }
        if (PRIORITY_ALIASES[lower]) { out.priority = PRIORITY_ALIASES[lower]; continue; }
        // tag conocido por convencion (bug/fix/refactor/feature/docs…) sin `+`
        if (TAG_COLORS[lower]) { out.tags.push(lower); continue; }
        out.warnings.push(t);
    }

    // sin duplicados (p.ej. `*future*` + `*next*` o `+bug` + `bug`)
    out.tags = Array.from(new Set(out.tags));

    if (!out.action) out.action = "nn"; // por defecto: nueva nota
    return out;
}
