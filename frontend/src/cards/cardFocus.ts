/* ───────────────────────── noteit · card focus / thread view ─────────────────────────
   The read surface for a single card plus its DERIVED relations:
     · children  — incoming refs with kind=parent (cards filed under this one)
     · backlinks — incoming refs with kind=link  (cards that link to this one)
   The concept GUI had no such panel; this realizes PLAN.md's GetCard (D.7/D.8). It is
   a pure renderer: it owns no state and resolves nothing — the caller hands it already
   resolved CardVMs and receives intent callbacks back. */

import type { CardVM } from "./cardData.js";
import { buildCardEl, type CardHandlers } from "./cardView.js";

export interface FocusHandlers {
    onBack?: () => void;               // return to the timeline
    onOpenCard?: (id: string) => void; // focus another card (a relation or the ref target)
    onLink?: (vm: CardVM) => void;     // start a linked reply to a card
}

/* everything the view needs, pre-resolved by the caller against the loaded set. */
export interface FocusData {
    card: CardVM;             // the focused card (backlinks/children already filled)
    refTarget: CardVM | null; // the card `card` points AT (its outgoing ref), if loaded
    children: CardVM[];       // resolved incoming kind=parent
    backlinks: CardVM[];      // resolved incoming kind=link
    missing: number;          // relation ids that could not be resolved (counts only)
}

/* render the focus view into `host`. The host owns the DOM; we rebuild it wholesale. */
export function renderCardFocus(host: HTMLElement, data: FocusData, handlers: FocusHandlers = {}): void {
    const wrap = document.createElement("div");
    wrap.className = "card-focus";

    /* header: a back affordance + the focused card's faint id. */
    const head = document.createElement("div");
    head.className = "focus-head";
    const back = document.createElement("button");
    back.className = "focus-back";
    back.type = "button";
    back.textContent = "← timeline";
    back.addEventListener("click", () => handlers.onBack?.());
    head.appendChild(back);
    const id = document.createElement("span");
    id.className = "focus-id";
    id.textContent = `#${data.card.shortId}`;
    head.appendChild(id);
    wrap.appendChild(head);

    /* the focused card itself — read mode (non-clickable, no link button). Its outgoing
       ref still renders as the "→ #…" preview and stays navigable. */
    const lead = buildCardEl(data.card, {
        mode: "embed",
        refTarget: data.refTarget,
        handlers: { onOpenRef: handlers.onOpenCard },
    });
    lead.classList.add("focus-lead");
    wrap.appendChild(lead);

    /* relation sections. children first (nesting), then neutral backlinks. */
    appendSection(wrap, "hijas", "↳", data.children, handlers);
    appendSection(wrap, "enlazadas", "←", data.backlinks, handlers);

    if (data.children.length === 0 && data.backlinks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "focus-empty";
        empty.textContent = "Sin tarjetas enlazadas — pulsá l para enlazar una, o p para anidar una hija.";
        wrap.appendChild(empty);
    }

    if (data.missing > 0) {
        const warn = document.createElement("div");
        warn.className = "focus-missing";
        warn.textContent = `${data.missing} relación${data.missing === 1 ? "" : "es"} fuera de la vista actual`;
        wrap.appendChild(warn);
    }

    host.replaceChildren(wrap);
}

/* one labelled list of related cards; each is clickable to focus its own thread. */
function appendSection(
    host: HTMLElement,
    label: string,
    glyph: string,
    cards: CardVM[],
    handlers: FocusHandlers,
): void {
    if (cards.length === 0) return;
    const sec = document.createElement("section");
    sec.className = "focus-section";

    const h = document.createElement("div");
    h.className = "focus-sec-head";
    h.textContent = `${glyph} ${label} · ${cards.length}`;
    sec.appendChild(h);

    for (const c of cards) {
        const node = document.createElement("div");
        node.className = "focus-rel";
        node.style.setProperty("--c", c.railColor);
        const ch: CardHandlers = {
            onClick: (vm) => handlers.onOpenCard?.(vm.id),
            onLink: handlers.onLink,
            onOpenRef: handlers.onOpenCard,
        };
        node.appendChild(buildCardEl(c, { mode: "timeline", handlers: ch }));
        sec.appendChild(node);
    }
    host.appendChild(sec);
}
