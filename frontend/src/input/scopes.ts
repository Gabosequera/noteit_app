/**
 * scopes.ts — Abstract focus-scope identifiers and spatial adjacency data.
 *
 * A "scope" is the logical region that currently has keyboard focus (vscode's
 * "when" context / nvim's mode-ish concept). Key bindings resolve against the
 * active scope, then fall back to GLOBAL. The actual DOM focus management lives
 * in the app (main.ts); this module is pure data so the logic stays abstract.
 */

/** A scope is just a stable string identifier. */
export type Scope = string;

/** The left sidebar / list of notes. */
export const SIDEBAR: Scope = "sidebar";
/** The main document / note body area. */
export const DOCUMENT: Scope = "document";
/** The compose region (e.g. a new card / message input). */
export const COMPOSE: Scope = "compose";
/** Transient scope active while a leader-key sequence is pending. */
export const LEADER: Scope = "leader";
/** The command-line / ":" prompt scope. */
export const CMDLINE: Scope = "cmdline";
/** Fallback scope; bindings here apply everywhere unless overridden. */
export const GLOBAL: Scope = "global";

/**
 * Spatial adjacency for horizontal focus movement.
 *
 * The app reads SCOPE_LEFT / SCOPE_RIGHT to move focus horizontally (the
 * `scope.left` / `scope.right` commands). A missing entry means "no neighbor in
 * that direction" — the app should keep focus where it is.
 *
 * Example: pressing the `scope.left` command while in `document` moves focus to
 * `sidebar` because SCOPE_LEFT["document"] === "sidebar".
 */
export const SCOPE_LEFT: Readonly<Record<Scope, Scope>> = {
  [COMPOSE]: SIDEBAR,
  [DOCUMENT]: SIDEBAR,
};

export const SCOPE_RIGHT: Readonly<Record<Scope, Scope>> = {
  [SIDEBAR]: DOCUMENT,
};
