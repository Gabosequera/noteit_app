/**
 * keymap.ts — Pure key→command DATA and resolution.
 *
 * Key bindings are plain data: (chord, scope) → command id. The current
 * defaults live in DEFAULT_KEYMAP, but the Keymap class is intentionally
 * structured so a future TOML config can replace the defaults without touching
 * any logic — you just construct `new Keymap(loadedBindings)`.
 */

import type { Scope } from "./scopes";
import { GLOBAL } from "./scopes";

export interface Binding {
  /** Normalized chord string, as produced by parseChord (e.g. "ctrl+j"). */
  keys: string;
  /** Scope this binding applies in. */
  scope: Scope;
  /** Command id to run when the chord fires in the scope. */
  command: string;
}

/** Map special KeyboardEvent.key values to canonical chord tokens. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  " ": "space",
  Enter: "enter",
  Escape: "escape",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * Produce a normalized chord string from a KeyboardEvent.
 *
 * Rules:
 *  - Modifiers prefixed in fixed order: `ctrl+alt+shift+meta+`.
 *  - Base key lowercased.
 *  - Special keys mapped: " "→"space", "Enter"→"enter", "Escape"→"escape",
 *    arrows→"up"/"down"/"left"/"right".
 *  - Single printable chars pass through (":" stays ":").
 *
 * SHIFT POLICY: `shift+` is only emitted for keys whose identity does NOT already
 * encode the shift — i.e. letters (so "G" → "shift+g") and named keys (so
 * shift+Enter → "shift+enter"). For shifted PUNCTUATION the produced character
 * already reflects the shift (":" is Shift+";", "?" is Shift+"/"), so adding
 * "shift+" would make the chord unmatchable against a natural ":" binding. We
 * therefore drop shift for single non-letter printable characters.
 *
 * Pure and deterministic — depends only on the event's key/modifier fields.
 */
export function parseChord(ev: KeyboardEvent): string {
  const raw = ev.key;
  const base = KEY_ALIASES[raw] ?? raw.toLowerCase();

  // Shift is meaningful for letters and named/special keys; for shifted
  // punctuation the base character already carries it.
  const shiftRelevant = base.length > 1 || /^[a-z]$/.test(base);

  let chord = "";
  if (ev.ctrlKey) chord += "ctrl+";
  if (ev.altKey) chord += "alt+";
  if (ev.shiftKey && shiftRelevant) chord += "shift+";
  if (ev.metaKey) chord += "meta+";
  return chord + base;
}

/**
 * Resolves (scope, chord) → command id using a layered lookup. Bindings are
 * indexed once at construction into nested maps for O(1) resolution and easy
 * future override semantics (re-register to overwrite, filter to remove).
 */
export class Keymap {
  /** scope → (chord → command id) */
  private readonly index = new Map<Scope, Map<string, string>>();
  private readonly raw: Binding[];

  constructor(bindings: Binding[]) {
    this.raw = [...bindings];
    for (const b of this.raw) {
      let byChord = this.index.get(b.scope);
      if (!byChord) {
        byChord = new Map<string, string>();
        this.index.set(b.scope, byChord);
      }
      // Last binding wins, enabling overrides from layered configs.
      byChord.set(b.keys, b.command);
    }
  }

  /**
   * Resolve a chord in a scope. Checks the given scope first, then falls back
   * to GLOBAL. Returns the command id, or null if unbound.
   */
  resolve(scope: Scope, chord: string): string | null {
    const inScope = this.index.get(scope)?.get(chord);
    if (inScope !== undefined) return inScope;
    if (scope !== GLOBAL) {
      const global = this.index.get(GLOBAL)?.get(chord);
      if (global !== undefined) return global;
    }
    return null;
  }

  /** Snapshot of the raw bindings backing this keymap. */
  bindings(): Binding[] {
    return [...this.raw];
  }
}

/**
 * Default bindings. This is the seed data a future TOML config will replace /
 * layer on top of. Pure data — no behavior here.
 */
export const DEFAULT_KEYMAP: Binding[] = [
  // Global ctrl-based navigation (works in any scope).
  { keys: "ctrl+j", scope: "global", command: "cursor.down" },
  { keys: "ctrl+k", scope: "global", command: "cursor.up" },
  { keys: "ctrl+h", scope: "global", command: "scope.left" },
  { keys: "ctrl+l", scope: "global", command: "scope.right" },

  // Vim-style bare j/k within list-like scopes.
  { keys: "j", scope: "sidebar", command: "cursor.down" },
  { keys: "k", scope: "sidebar", command: "cursor.up" },
  { keys: "j", scope: "document", command: "cursor.down" },
  { keys: "k", scope: "document", command: "cursor.up" },

  // Leader key.
  { keys: "space", scope: "sidebar", command: "leader.open" },
  { keys: "space", scope: "document", command: "leader.open" },

  // Command line.
  { keys: ":", scope: "sidebar", command: "cmdline.open" },
  { keys: ":", scope: "document", command: "cmdline.open" },

  // Compose submit.
  { keys: "enter", scope: "compose", command: "compose.submit" },

  // Universal escape.
  { keys: "escape", scope: "global", command: "scope.escape" },

  // Insert / edit entry points (scope-specific meaning). In the document scope
  // the CodeMirror+vim buffer owns `i` (insert mode) directly, so there is no
  // app-level binding for it there.
  { keys: "i", scope: "sidebar", command: "scope.focusCompose" },

  // Leader sub-keys (active while LEADER scope is pending).
  { keys: "n", scope: "leader", command: "note.create" },
  { keys: "c", scope: "leader", command: "card.create" },
  { keys: "escape", scope: "leader", command: "scope.escape" },
];
