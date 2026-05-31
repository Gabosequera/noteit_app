/**
 * input — Abstract, keyboard-first command + scope + keymap core.
 *
 * Public entry point. The app wires this up by:
 *   1. constructing a CommandRegistry and registering concrete Commands,
 *   2. constructing a Keymap (DEFAULT_KEYMAP today, TOML config later),
 *   3. constructing an InputDispatcher with a getScope() accessor,
 *   4. forwarding keydown events to dispatcher.handle(ev).
 */

export type { Scope } from "./scopes";
export {
  SIDEBAR,
  DOCUMENT,
  COMPOSE,
  LEADER,
  CMDLINE,
  GLOBAL,
  SCOPE_LEFT,
  SCOPE_RIGHT,
} from "./scopes";

export type { Command } from "./commands";
export { CommandRegistry } from "./commands";

export type { Binding } from "./keymap";
export { parseChord, Keymap, DEFAULT_KEYMAP } from "./keymap";

export { InputDispatcher } from "./dispatch";
