/* ───────────────────────────── noteit · editor ─────────────────────────────
   CodeMirror 6 as the note text surface. This is the "Obsidian model": the note
   body is plain markdown and we edit it directly with REAL vim motions (hjkl,
   w/b/e, ciw, visual, `:`), a block cursor like nvim, and incremental rendering
   that stays fast on long documents. No homegrown contenteditable, no per-block
   boxes — one virtualized buffer.

   The vim engine comes from @replit/codemirror-vim (the same modal model nvim
   uses, reimplemented inside a real text editor) so we DON'T reimplement motions
   ourselves and we DON'T ship an nvim process. The app keeps only a thin layer on
   top for structural moves vim has no concept of (panes, notes, cards). */

import { EditorView, keymap, drawSelection, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { vim, getCM, Vim } from "@replit/codemirror-vim";

/** Vim modes surfaced to the app statusline. */
export type VimMode = "normal" | "insert" | "visual" | "replace" | "visual-line" | "visual-block";

/** A vim ex-command (`:name`) the app registers on top of the editor — e.g.
    `:embed` or `:timeline`. vim owns the `:` line, so structural triggers the app
    needs from INSIDE the editor are exposed here rather than as app keybindings. */
export interface ExCommand {
    /** Full command name typed after `:` (e.g. "embed"). */
    name: string;
    /** A literal prefix of `name` vim accepts as an abbreviation (e.g. "emb"). */
    prefix: string;
    /** What to run when the command fires. */
    run: () => void;
}

export interface NoteEditorOpts {
    parent: HTMLElement;
    doc: string;
    /** Fired (every keystroke that mutates the doc) with the full markdown. */
    onChange?: (doc: string) => void;
    /** Fired whenever the vim mode changes — drives the bottom statusline. */
    onModeChange?: (mode: VimMode) => void;
    /** Fired whenever the cursor moves (1-based line + column) — drives the
        line:col segment in the statusline, nvim-style. */
    onCursorChange?: (line: number, col: number) => void;
    /** Show line numbers (off by default — prose reads cleaner without them). */
    lineNumbers?: boolean;
    /** Extra CodeMirror extensions appended after the base set (e.g. card embeds). */
    extensions?: Extension[];
    /** Vim ex-commands to register (`:name`). Registration is global to the vim
        engine and idempotent — see registerExCommands. */
    exCommands?: ExCommand[];
}

/* Vim.defineEx mutates a process-global command table, so registering the same
   command on every NoteEditor construction would stack duplicate handlers. We split
   the two concerns:
     · the LIVE handler for a name lives in `exHandlers` and is overwritten on every
       registration — so re-creating the editor always runs the newest closure (no
       stale-editor capture), and the global vim command no-ops if it was cleared;
     · the actual Vim.defineEx call happens once per (name, prefix) — guarded by
       `exDefined` — because redefining the same name with a DIFFERENT prefix would
       silently keep vim's first prefix. A conflicting prefix is a programming error,
       so we warn rather than fail silently. */
const exHandlers = new Map<string, () => void>();
const exDefined = new Map<string, string>(); // name → the prefix it was defined with
function registerExCommands(cmds: ExCommand[]): void {
    for (const cmd of cmds) {
        exHandlers.set(cmd.name, cmd.run); // latest closure wins
        const prior = exDefined.get(cmd.name);
        if (prior === undefined) {
            exDefined.set(cmd.name, cmd.prefix);
            Vim.defineEx(cmd.name, cmd.prefix, () => {
                // Defer so vim finishes tearing down its ex-command line before the
                // app moves focus/surface out from under it.
                queueMicrotask(() => exHandlers.get(cmd.name)?.());
            });
        } else if (prior !== cmd.prefix) {
            console.warn(`ex-command "${cmd.name}" re-registered with prefix "${cmd.prefix}" but vim keeps "${prior}"`);
        }
    }
}

/* noteit dark theme for the editor. Uses the app's CSS custom properties so it
   tracks light/dark and any palette change for free. Transparent background lets
   the navy detail panel show through. */
const noteitTheme = EditorView.theme(
    {
        "&": {
            color: "var(--fg)",
            backgroundColor: "transparent",
            height: "100%",
            fontSize: "14px",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            lineHeight: "1.7",
            overflow: "auto",
        },
        ".cm-content": {
            fontFamily: "var(--font-mono)",
            caretColor: "var(--fg)",
            padding: "4px 0 40vh 0", // bottom padding: last line can scroll to mid-screen
        },
        ".cm-line": { padding: "0 2px" },
        // selection
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
            backgroundColor: "rgba(88,166,255,0.20)",
        },
        // nvim-style block cursor (vim normal/visual). Solid white; the char
        // underneath flips to the ink color so it stays readable.
        ".cm-fat-cursor": {
            background: "#fff",
            color: "var(--ink)",
        },
        "&:not(.cm-focused) .cm-fat-cursor": {
            background: "none",
            outline: "1px solid #fff",
            color: "inherit",
        },
        // thin caret for insert mode
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    },
    { dark: true }
);

/* Minimal markdown highlight so headings/emphasis/code read nicely without a
   heavy language-data bundle. */
const noteitHighlight = HighlightStyle.define([
    { tag: t.heading, color: "var(--accent)", fontWeight: "700" },
    { tag: t.strong, color: "var(--fg)", fontWeight: "700" },
    { tag: t.emphasis, color: "var(--fg)", fontStyle: "italic" },
    { tag: t.link, color: "var(--accent-2)", textDecoration: "underline" },
    { tag: t.monospace, color: "var(--syn-cmt)" },
    { tag: [t.list, t.quote], color: "var(--fg-dim)" },
    { tag: t.meta, color: "var(--fg-mute)" },
]);

/** Map @replit/codemirror-vim's mode-change payload onto our VimMode union. */
function toVimMode(e: { mode?: string; subMode?: string }): VimMode {
    if (e.mode === "visual") {
        if (e.subMode === "linewise") return "visual-line";
        if (e.subMode === "blockwise") return "visual-block";
        return "visual";
    }
    if (e.mode === "replace") return "replace";
    if (e.mode === "insert") return "insert";
    return "normal";
}

export class NoteEditor {
    readonly view: EditorView;
    private onChange?: (doc: string) => void;
    /** Set while setDoc() replaces the whole buffer, so a programmatic swap
        (e.g. switching notes) never fires onChange and triggers a spurious save. */
    private suppressChange = false;

    constructor(opts: NoteEditorOpts) {
        this.onChange = opts.onChange;

        const onCursorChange = opts.onCursorChange;
        const changeListener = EditorView.updateListener.of((u) => {
            if (u.docChanged && this.onChange && !this.suppressChange) {
                this.onChange(u.state.doc.toString());
            }
            // Report cursor line:col on any selection or doc change (incl. the
            // programmatic setDoc that resets to the top), so the statusline
            // line:col segment tracks the caret like nvim.
            if (onCursorChange && (u.selectionSet || u.docChanged)) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                onCursorChange(line.number, head - line.from + 1);
            }
        });

        const extensions = [
            vim(), // MUST come first: gives its keymap top precedence.
            history(),
            drawSelection(),
            indentOnInput(),
            markdown(),
            syntaxHighlighting(noteitHighlight),
            EditorView.lineWrapping, // prose wraps like Obsidian
            noteitTheme,
            keymap.of([...defaultKeymap, ...historyKeymap]),
            changeListener,
            ...(opts.extensions ?? []),
        ];
        if (opts.lineNumbers) extensions.splice(1, 0, lineNumbers());

        if (opts.exCommands) registerExCommands(opts.exCommands);

        this.view = new EditorView({
            state: EditorState.create({ doc: opts.doc, extensions }),
            parent: opts.parent,
        });

        if (opts.onModeChange) {
            const cm = getCM(this.view);
            // CodeMirror5-compat shim exposes vim's lifecycle events.
            cm?.on?.("vim-mode-change", (e: { mode?: string; subMode?: string }) =>
                opts.onModeChange!(toVimMode(e))
            );
            opts.onModeChange("normal"); // editors boot in normal mode
        }
    }

    /** Swap the whole document (used when the active note changes) without
        tearing down the view — keeps note-switching cheap. */
    setDoc(text: string) {
        if (text === this.getDoc()) return;
        this.suppressChange = true;
        try {
            this.view.dispatch({
                changes: { from: 0, to: this.view.state.doc.length, insert: text },
            });
        } finally {
            // dispatch is synchronous, so the flag is back down before any user edit.
            this.suppressChange = false;
        }
    }

    getDoc(): string {
        return this.view.state.doc.toString();
    }

    focus() {
        this.view.focus();
    }

    destroy() {
        this.view.destroy();
    }
}
