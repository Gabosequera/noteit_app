/* ───────────────────────── noteit · taxonomy (frontend mirror) ─────────────────────────
   The AUTHORITATIVE taxonomy lives server-side in taxonomy.go (+ docs/v3/taxonomy.md).
   This file MIRRORS it for two read-only, presentation purposes that must stay close to
   the user as they type:
     · the composer's live preview (resolve a typed synonym → its canonical axis chip),
     · the in-app welcome/help page (list every axis, value and synonym).

   It does NOT re-implement the resolver's WRITE semantics (conflict = hard error, the
   single free-area slot, accent folding on write). The server remains the source of
   truth; if this drifts, the only cost is a preview chip that looks slightly different
   from what the backend ultimately stores. Keep this table in sync with taxonomy.go. */

export interface AxisValue {
    canonical: string;
    synonyms: string[];
}
export interface AxisDef {
    name: string;          // axis key (type/status/…)
    multi: boolean;        // area is the one multi-value axis
    label: string;         // human title for the welcome page
    desc: string;          // one-line description
    values: AxisValue[];
}

/* Mirror of taxonomy.go `var taxonomy`. Order matches the doc. */
export const TAXONOMY: AxisDef[] = [
    {
        name: "type", multi: false, label: "type", desc: "qué clase de trabajo es (default: note)",
        values: [
            { canonical: "note", synonyms: ["nota", "general"] },
            { canonical: "rem", synonyms: ["reminder", "recordatorio", "recordar", "remind"] },
            { canonical: "feat", synonyms: ["feature", "new", "add", "nuevo"] },
            { canonical: "fix", synonyms: ["bug", "hotfix", "arreglar"] },
            { canonical: "refactor", synonyms: ["refac", "cleanup", "limpiar"] },
            { canonical: "perf", synonyms: ["performance", "optimize"] },
            { canonical: "docs", synonyms: ["doc", "readme"] },
            { canonical: "test", synonyms: ["tests", "testing"] },
            { canonical: "chore", synonyms: ["build", "ci", "config"] },
        ],
    },
    {
        name: "status", multi: false, label: "status", desc: "en qué punto está (default: todo)",
        values: [
            { canonical: "todo", synonyms: ["pendiente", "pending"] },
            { canonical: "doing", synonyms: ["wip", "in-progress", "haciendo"] },
            { canonical: "blocked", synonyms: ["bloqueado", "stuck"] },
            { canonical: "review", synonyms: ["in-review", "qa", "pr"] },
            { canonical: "done", synonyms: ["hecho", "listo", "closed", "ready", "solved", "resuelto"] },
        ],
    },
    {
        name: "priority", multi: false, label: "priority", desc: "urgencia (opcional)",
        values: [
            { canonical: "p0", synonyms: ["critical", "urgent", "urgente"] },
            { canonical: "p1", synonyms: ["high", "alta"] },
            { canonical: "p2", synonyms: ["medium", "normal"] },
            { canonical: "p3", synonyms: ["low", "baja"] },
        ],
    },
    {
        name: "horizon", multi: false, label: "horizon", desc: "cuándo (opcional, default lógico now)",
        values: [
            { canonical: "now", synonyms: ["ahora", "current"] },
            { canonical: "next", synonyms: ["siguiente", "upcoming"] },
            { canonical: "future", synonyms: ["futuro", "later", "missing", "soon"] },
        ],
    },
    {
        name: "area", multi: true, label: "area", desc: "dominio — multi-valor; el ÚLTIMO token desconocido se acepta como área libre",
        values: [
            { canonical: "client", synonyms: ["frontend", "ui"] },
            { canonical: "backend", synonyms: ["server", "back"] },
            { canonical: "api", synonyms: ["endpoint", "rest"] },
            { canonical: "data", synonyms: ["db", "database", "sql"] },
            { canonical: "infra", synonyms: ["ops", "deploy", "devops"] },
            { canonical: "security", synonyms: ["auth", "sec"] },
            { canonical: "deps", synonyms: ["dependencies", "package"] },
            { canonical: "tooling", synonyms: ["tools", "cli", "lint"] },
        ],
    },
    {
        name: "effort", multi: false, label: "effort", desc: "tamaño estimado (opcional)",
        values: [
            { canonical: "xs", synonyms: ["trivial", "tiny"] },
            { canonical: "s", synonyms: ["small", "pequeno"] },
            { canonical: "m", synonyms: ["mediano"] },
            { canonical: "l", synonyms: ["large", "grande"] },
        ],
    },
];

/* token (canonical OR synonym, normalized) → { axis, canonical }. Built once. */
export interface TokenMatch { axis: string; canonical: string; multi: boolean; }
const TOKEN_INDEX: Map<string, TokenMatch> = (() => {
    const idx = new Map<string, TokenMatch>();
    for (const ax of TAXONOMY) {
        for (const v of ax.values) {
            const m: TokenMatch = { axis: ax.name, canonical: v.canonical, multi: ax.multi };
            idx.set(v.canonical, m);
            for (const s of v.synonyms) idx.set(s, m);
        }
    }
    return idx;
})();

/* normalize a token the same way the server does for matching: lowercase + strip the
   Spanish-relevant accents. (Write-time area folding is not reproduced; not needed for
   matching a canonical/synonym.) */
const ACCENTS: Record<string, string> = {
    "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ü": "u", "ñ": "n",
    "à": "a", "è": "e", "ì": "i", "ò": "o", "ù": "u",
};
export function normalizeToken(s: string): string {
    return s.trim().toLowerCase().replace(/[áéíóúüñàèìòù]/g, (c) => ACCENTS[c] ?? c);
}

/* resolve a typed token to its canonical axis match, or null if unrecognized. */
export function resolveToken(tok: string): TokenMatch | null {
    return TOKEN_INDEX.get(normalizeToken(tok)) ?? null;
}
