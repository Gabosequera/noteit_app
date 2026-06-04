/* ───────────────────────── noteit · card + timeline renderers (v3) ─────────────────────────
   Imperative DOM builders that mirror the concept's card.jsx / views.jsx, but in
   vanilla TS and wired to the real CardVM. One card renders the same in the
   timeline, embedded in a doc, or previewed in the cmdline. No title, no author —
   a faint id, a timestamp, the body, colored axis chips, and a kind-colored rail. */

import { type CardVM, fmtTime, firstLine, highlightBody } from "./cardData.js";

export type CardMode = "timeline" | "embed" | "preview";

export interface CardHandlers {
    onClick?: (vm: CardVM) => void;       // open / focus the card (timeline)
    onLink?: (vm: CardVM) => void;        // start a linked reply to this card
    onOpenRef?: (id: string) => void;     // jump to the card this one references
}

const SVG = "http://www.w3.org/2000/svg";
function svgIcon(path: string, cls = ""): SVGSVGElement {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    if (cls) s.setAttribute("class", cls);
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", path);
    s.appendChild(p);
    return s;
}

const LINK_PATH = "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1";

/* the small "referencing" preview shown atop a card that points at another. */
function buildCardRef(target: CardVM, handlers: CardHandlers): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "card-ref";
    wrap.innerHTML =
        `<div class="ref-rail"></div>
         <div class="ref-inner">
           <div class="ref-label"></div>
           <div class="ref-body"></div>
         </div>`;
    const label = wrap.querySelector(".ref-label")!;
    const icon = svgIcon(LINK_PATH);
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    label.appendChild(icon);
    label.appendChild(document.createTextNode(` ${target.refKind === "parent" ? "parent" : "link"} · #${target.shortId}`));
    wrap.querySelector(".ref-body")!.textContent = firstLine(target.body);
    wrap.addEventListener("click", (e) => { e.stopPropagation(); handlers.onOpenRef?.(target.id); });
    return wrap;
}

export interface BuildCardOpts {
    mode?: CardMode;
    isCursor?: boolean;
    refTarget?: CardVM | null;   // the card this one references (for the ref preview)
    linksOut?: number;           // how many cards reference this one
    handlers?: CardHandlers;
}

/* build one card element. */
export function buildCardEl(vm: CardVM, opts: BuildCardOpts = {}): HTMLElement {
    const mode = opts.mode ?? "timeline";
    const handlers = opts.handlers ?? {};
    const clickable = mode === "timeline";

    const art = document.createElement("article");
    art.className = `card ${clickable ? "clickable" : ""} ${opts.isCursor ? "is-cursor" : ""}`.trim();
    art.style.setProperty("--rail", vm.railColor);
    art.dataset.id = vm.id;

    /* head */
    const head = document.createElement("header");
    head.className = "card-head";
    const ts = document.createElement("span");
    ts.className = "card-ts";
    ts.textContent = fmtTime(vm.created);
    head.appendChild(ts);
    const dot = document.createElement("span");
    dot.className = "card-dot";
    dot.style.background = vm.railColor;
    head.appendChild(dot);
    const spacer = document.createElement("span");
    spacer.className = "card-spacer";
    head.appendChild(spacer);
    if ((opts.linksOut ?? 0) > 0) {
        const links = document.createElement("span");
        links.className = "card-links";
        const li = svgIcon(LINK_PATH);
        li.setAttribute("width", "11"); li.setAttribute("height", "11");
        li.setAttribute("fill", "none"); li.setAttribute("stroke", "currentColor");
        li.setAttribute("stroke-width", "2"); li.setAttribute("stroke-linecap", "round");
        li.setAttribute("stroke-linejoin", "round");
        links.appendChild(li);
        links.appendChild(document.createTextNode(` ${opts.linksOut}`));
        head.appendChild(links);
    }
    const id = document.createElement("span");
    id.className = "card-id";
    id.textContent = `#${vm.shortId}`;
    head.appendChild(id);
    if (mode === "timeline") {
        const linkBtn = document.createElement("button");
        linkBtn.className = "card-icon-btn";
        linkBtn.title = "link a esta tarjeta";
        linkBtn.appendChild(svgIcon(LINK_PATH));
        linkBtn.addEventListener("click", (e) => { e.stopPropagation(); handlers.onLink?.(vm); });
        head.appendChild(linkBtn);
    }
    art.appendChild(head);

    /* ref preview */
    if (opts.refTarget) art.appendChild(buildCardRef(opts.refTarget, handlers));

    /* body */
    const body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = highlightBody(vm.body);
    art.appendChild(body);

    /* chips (the 6 axes) */
    if (vm.chips.length) {
        const tags = document.createElement("div");
        tags.className = "card-tags";
        for (const chip of vm.chips) {
            const el = document.createElement("span");
            el.className = "tag";
            el.style.setProperty("--tc", chip.color);
            el.title = chip.axis;
            el.textContent = chip.label;
            tags.appendChild(el);
        }
        art.appendChild(tags);
    }

    if (clickable) art.addEventListener("click", () => handlers.onClick?.(vm));
    return art;
}

/* ════════════════ timeline ════════════════ */
export interface TimelineOpts {
    cursorId?: string | null;
    handlers?: CardHandlers;
    onSetCursor?: (id: string) => void;
}

import { groupByDay } from "./cardData.js";

/* render the day-grouped timeline into `host`. Returns nothing; the host owns the
   DOM. linksOut + refTargets are derived from the visible set. */
export function renderTimeline(host: HTMLElement, cards: CardVM[], opts: TimelineOpts = {}): void {
    host.innerHTML = "";
    const byId = new Map(cards.map((c) => [c.id, c]));
    const linksOut = new Map<string, number>();
    for (const c of cards) {
        if (c.refId && c.refKind !== "parent") linksOut.set(c.refId, (linksOut.get(c.refId) ?? 0) + 1);
    }

    const tl = document.createElement("div");
    tl.className = "timeline";

    if (cards.length === 0) {
        tl.innerHTML = `<div class="tl-empty">
            <div class="tl-empty-title">Línea de tiempo de tarjetas</div>
            <div class="tl-empty-hint">Todavía no hay tarjetas. Pulsá <kbd>i</kbd>, <kbd>+</kbd> o <kbd>:</kbd> para crear la primera.</div>
        </div>`;
        host.appendChild(tl);
        return;
    }

    for (const g of groupByDay(cards)) {
        const stamp = document.createElement("div");
        stamp.className = "tl-daystamp";
        stamp.textContent = g.day;
        tl.appendChild(stamp);

        const track = document.createElement("div");
        track.className = "tl-track";
        for (const c of g.items) {
            const node = document.createElement("div");
            node.className = `tl-node ${opts.cursorId === c.id ? "is-cursor" : ""}`.trim();
            node.style.setProperty("--c", c.railColor);
            const refTarget = c.refId ? byId.get(c.refId) ?? null : null;
            const handlers: CardHandlers = {
                ...opts.handlers,
                onClick: (vm) => { opts.onSetCursor?.(vm.id); opts.handlers?.onClick?.(vm); },
                onOpenRef: (id) => { opts.onSetCursor?.(id); opts.handlers?.onOpenRef?.(id); },
            };
            node.appendChild(buildCardEl(c, {
                mode: "timeline",
                isCursor: opts.cursorId === c.id,
                refTarget,
                linksOut: linksOut.get(c.id) ?? 0,
                handlers,
            }));
            track.appendChild(node);
        }
        tl.appendChild(track);
    }
    host.appendChild(tl);
}
