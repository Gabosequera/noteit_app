/* ───────────────────────── noteit · card embeds (editor decoration) ─────────────────────────
   A note (mutable markdown) can embed an already-created, immutable card by writing a
   light token on its OWN line:

       !card[<uuid>]

   This module is the editor half of PLAN.md §4. It is deliberately CARD-AGNOSTIC: it
   only locates the token and owns the CodeMirror decoration lifecycle. Resolving the
   uuid to a card and building the read-only DOM (or a tombstone for a missing card) is
   the caller's job, handed in as `EmbedSpec.render(id)`. So this file never imports card
   data — the editor stays a generic text surface, the card knowledge lives in the app.

   Why block, whole-line, exact match:
     · A card renders as a sizeable box, so the token is replaced by a BLOCK widget that
       occupies its own line (matching the design concept's stacked embeds).
     · Only a line whose ENTIRE text is the token becomes an embed. An indented or
       inline `!card[…]` stays literal text, so markdown lists/quotes are never hijacked
       and the source you see is the source you have.
     · Block decorations MUST come from a StateField (the view needs them before layout),
       so this is a field, not a view plugin.
     · No atomicRanges: the underlying line text is real, so a plain `dd` deletes an
       embed like any other line — no special affordance, no cursor trap. */

import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import type { Extension, EditorState } from "@codemirror/state";

/* a canonical uuid (v7 in practice, but we accept any well-formed uuid). */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/* a line is an embed ONLY if it is exactly the token (trailing spaces tolerated, NO
   leading whitespace — an indented token stays literal so we never hide indentation). */
const EMBED_LINE = new RegExp(`^!card\\[(${UUID})\\]\\s*$`);

/** The canonical token text for a card id (used by the composer + tests). */
export function embedToken(id: string): string {
    return `!card[${id}]`;
}

/** Everything the editor needs from the app to paint an embed. Resolution + DOM live
    in the caller; this module only decides WHERE an embed goes. */
export interface EmbedSpec {
    /* build the read-only DOM for the embed with this id. The caller resolves the card
       (or returns a tombstone node if it is missing) and wires any of its own click
       affordances. Called once per distinct (id, version) — re-run when refreshEmbeds
       bumps the version. */
    render(id: string): HTMLElement;
}

/* Bumping the version forces every widget to be considered stale (eq() compares the
   version) so the card store reloading re-resolves embeds without a doc edit. */
const bumpEffect = StateEffect.define<void>();

const embedVersion = StateField.define<number>({
    create: () => 0,
    update: (v, tr) => (tr.effects.some((e) => e.is(bumpEffect)) ? v + 1 : v),
});

class EmbedWidget extends WidgetType {
    constructor(
        readonly id: string,
        readonly spec: EmbedSpec,
        readonly version: number,
    ) {
        super();
    }
    /* identical id + version (+ same resolver) → CodeMirror keeps the existing DOM. A
       version bump (card store reload), a different id, or a swapped EmbedSpec rebuilds
       it. Comparing spec keeps the widget correct if the extension is ever reconfigured
       with a new resolver under the same id/version. */
    eq(other: EmbedWidget): boolean {
        return other.id === this.id && other.version === this.version && other.spec === this.spec;
    }
    toDOM(): HTMLElement {
        return this.spec.render(this.id);
    }
    /* let the embed's own DOM handlers (e.g. an "open thread" affordance) run instead of
       the editor swallowing the event. */
    ignoreEvent(): boolean {
        return true;
    }
}

function buildEmbeds(state: EditorState, spec: EmbedSpec, version: number): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = state.doc;
    for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        const m = EMBED_LINE.exec(line.text);
        if (m) {
            builder.add(
                line.from,
                line.to,
                Decoration.replace({ widget: new EmbedWidget(m[1], spec, version), block: true }),
            );
        }
    }
    return builder.finish();
}

function embedField(spec: EmbedSpec): Extension {
    const field = StateField.define<DecorationSet>({
        create: (state) => buildEmbeds(state, spec, 0),
        update: (deco, tr) => {
            // Recompute from the post-transaction doc on any edit or version bump. On a
            // selection-only transaction nothing moved, so the line-anchored set stands.
            if (tr.docChanged || tr.effects.some((e) => e.is(bumpEffect))) {
                return buildEmbeds(tr.state, spec, tr.state.field(embedVersion));
            }
            return deco;
        },
        provide: (f) => EditorView.decorations.from(f),
    });
    return field;
}

/** The editor extension that turns `!card[uuid]` lines into read-only card embeds.
    embedVersion is listed first so the deco field reads the freshly-bumped version. */
export function cardEmbeds(spec: EmbedSpec): Extension {
    return [embedVersion, embedField(spec)];
}

/** Force every embed to re-resolve (call after the card store reloads). */
export function refreshEmbeds(view: EditorView): void {
    view.dispatch({ effects: bumpEffect.of() });
}

/** Insert an embed token for `id` on its own line at the cursor, then place the caret
    just after it. If the current line is blank the token takes it over; otherwise a
    fresh line is opened below so the token is always alone on its line (the only shape
    that renders as an embed). */
export function insertEmbed(view: EditorView, id: string): void {
    const token = embedToken(id);
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const lineEmpty = line.text.trim() === "";
    // Blank line → the token replaces it in place; otherwise nothing is replaced and a
    // fresh line is opened below (insert starts with "\n"). Either way the edit anchors
    // at line.to, with `from` stepping back to line.from only to consume the blank line.
    const from = lineEmpty ? line.from : line.to;
    const to = line.to;
    const insert = lineEmpty ? token : `\n${token}`;
    view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
    });
}
