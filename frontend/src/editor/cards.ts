/* ───────────────────────── noteit · editor / cards ─────────────────────────
   Live-preview rendering of inline status cards inside the CodeMirror buffer.

   In the Obsidian model the note body is plain markdown and a status card is an
   inline fence:

       :::card id=<uuid> created=<rfc3339> author=<name>
       …card text…
       :::

   Showing that fence raw is noise. This extension renders each well-formed card
   block as a styled widget (a block `replace` decoration), exactly like
   Obsidian's live preview — EXCEPT the block the cursor is currently inside,
   which falls back to raw text so the card stays editable with real vim motions.
   Click a rendered card to drop the cursor into it (reveals the raw fence).

   It is purely a *view* decoration: it never mutates the document, so getDoc()
   and the whole-body SaveBody still see the canonical fence text. The fence
   grammar here mirrors the Go parser (card.go) so what renders matches what the
   backend will parse. */

import {
    EditorView,
    Decoration,
    type DecorationSet,
    WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";

const FENCE_OPEN = ":::card";
const FENCE_CLOSE = ":::";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedCard {
    from: number; // doc offset: start of the open-fence line
    to: number; // doc offset: end of the close-fence line
    bodyPos: number; // doc offset where editing should land (first body line)
    id: string;
    created: string;
    author: string;
    links: number;
    body: string;
}

/** Parse a `:::card id=… created=… author=… links=a,b` header line. Returns null
    (→ treat as prose) unless `id` is a real UUID, matching parseCardHeader in
    card.go so the frontend never renders a fence the backend would reject. */
function parseHeader(line: string): Omit<ParsedCard, "from" | "to" | "bodyPos" | "body"> | null {
    const rest = line.slice(FENCE_OPEN.length).trim();
    if (!rest) return null;
    let id = "";
    let created = "";
    let author = "";
    let links = 0;
    for (const tok of rest.split(/\s+/)) {
        const eq = tok.indexOf("=");
        if (eq < 0) continue;
        const k = tok.slice(0, eq);
        const v = tok.slice(eq + 1);
        if (k === "id") id = v;
        else if (k === "created") created = v;
        else if (k === "author") {
            // Go writes author with url.QueryEscape (space → '+'); decode the mirror.
            try {
                author = decodeURIComponent(v.replace(/\+/g, " "));
            } catch {
                author = v;
            }
        } else if (k === "links") links = v ? v.split(",").length : 0;
    }
    if (!UUID_RE.test(id)) return null;
    return { id, created, author, links };
}

/** Walk the document line-by-line and collect every well-formed card fence with
    its document offsets. Tolerant like the Go parser: an unterminated or
    malformed fence is skipped (left as prose). */
function findCards(state: EditorState): ParsedCard[] {
    const doc = state.doc;
    const cards: ParsedCard[] = [];
    const total = doc.lines;
    let i = 1;
    while (i <= total) {
        const open = doc.line(i);
        const head = open.text.replace(/\r$/, "");
        const isOpen = head === FENCE_OPEN || head.startsWith(FENCE_OPEN + " ");
        if (!isOpen) {
            i++;
            continue;
        }
        // Find the matching bare close fence.
        let closeLine = -1;
        for (let j = i + 1; j <= total; j++) {
            if (doc.line(j).text.replace(/\r$/, "") === FENCE_CLOSE) {
                closeLine = j;
                break;
            }
        }
        const meta = closeLine > 0 ? parseHeader(head) : null;
        if (closeLine < 0 || !meta) {
            i++;
            continue;
        }
        const close = doc.line(closeLine);
        const body =
            closeLine > i + 1
                ? doc.sliceString(doc.line(i + 1).from, doc.line(closeLine - 1).to)
                : "";
        cards.push({
            from: open.from,
            to: close.to,
            bodyPos: doc.line(Math.min(i + 1, closeLine)).from,
            ...meta,
            body,
        });
        i = closeLine + 1;
    }
    return cards;
}

function fmtTs(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The rendered card block. Plain-text body for now (markdown rendering inside
    cards can come later); newlines are preserved via CSS white-space. */
class CardWidget extends WidgetType {
    constructor(readonly card: ParsedCard) {
        super();
    }

    eq(o: CardWidget): boolean {
        const a = this.card;
        const b = o.card;
        return (
            a.id === b.id &&
            a.body === b.body &&
            a.created === b.created &&
            a.author === b.author &&
            a.links === b.links &&
            a.bodyPos === b.bodyPos
        );
    }

    toDOM(): HTMLElement {
        const c = this.card;
        const el = document.createElement("article");
        el.className = "cm-card";
        el.dataset.bodypos = String(c.bodyPos);

        const head = document.createElement("header");
        head.className = "cm-card-head";

        const ts = document.createElement("span");
        ts.className = "cm-card-ts";
        ts.textContent = fmtTs(c.created);

        const spacer = document.createElement("span");
        spacer.className = "cm-card-spacer";

        head.append(ts, spacer);
        if (c.links > 0) {
            const lk = document.createElement("span");
            lk.className = "cm-card-links";
            lk.textContent = `↬ ${c.links}`;
            head.append(lk);
        }

        const author = document.createElement("span");
        author.className = "cm-card-author";
        author.textContent = c.author || "local";
        head.append(author);

        const body = document.createElement("div");
        body.className = "cm-card-body";
        body.textContent = c.body;

        el.append(head, body);
        return el;
    }

    // Let editor-level handlers (our mousedown below) see clicks on the widget.
    ignoreEvent(): boolean {
        return false;
    }
}

/** Build the decoration set: replace every card block with a widget, EXCEPT a
    block the main selection currently overlaps (reveal it raw for editing). */
function buildDecorations(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const sel = state.selection.main;
    for (const card of findCards(state)) {
        // Reveal (skip) the block the cursor/selection is inside so it stays editable.
        if (sel.from <= card.to && sel.to >= card.from) continue;
        builder.add(
            card.from,
            card.to,
            Decoration.replace({ widget: new CardWidget(card), block: true })
        );
    }
    return builder.finish();
}

/** Card decorations MUST be provided from a StateField, not a ViewPlugin:
    CodeMirror forbids block / line-spanning replace decorations from plugins
    ("Block decorations may not be specified via plugins") and throws on every
    update if you try — which silently breaks cursor rendering and insert mode.
    A StateField recomputes the set on each doc/selection change and feeds it
    through EditorView.decorations.from(). */
const cardField = StateField.define<DecorationSet>({
    create(state) {
        return buildDecorations(state);
    },
    update(deco, tr) {
        // Selection changes matter: the block under the cursor reveals raw.
        return tr.docChanged || tr.selection ? buildDecorations(tr.state) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/** Click a rendered card → drop the cursor into its body so the StateField
    reveals it as raw text for editing with real vim motions. */
const cardClick = EditorView.domEventHandlers({
    mousedown(e, view) {
        const t = e.target as HTMLElement | null;
        const card = t?.closest(".cm-card") as HTMLElement | null;
        if (!card) return false;
        const pos = Number(card.dataset.bodypos);
        if (Number.isNaN(pos)) return false;
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
        e.preventDefault();
        return true;
    },
});

/** The live-preview card extension: StateField decorations + click-to-reveal. */
export const cardPreview: Extension = [cardField, cardClick];
