/**
 * dispatch.ts — Glue between raw keyboard events and command execution.
 *
 * Generic and DOM-agnostic beyond consuming a KeyboardEvent: it parses the
 * chord, resolves it against the *current* scope (provided via a getter so the
 * app owns scope state), and runs the resolved command if it exists.
 */

import { parseChord } from "./keymap";
import type { Keymap } from "./keymap";
import type { CommandRegistry } from "./commands";
import type { Scope } from "./scopes";

export class InputDispatcher {
  constructor(
    private readonly keymap: Keymap,
    private readonly registry: CommandRegistry,
    private readonly getScope: () => Scope,
  ) {}

  /**
   * Handle one keyboard event.
   *
   * @returns true if the event resolved to a registered command and was run
   *          (caller should typically preventDefault / stopPropagation);
   *          false if unbound or unregistered (caller lets the event through).
   */
  handle(ev: KeyboardEvent): boolean {
    const chord = parseChord(ev);
    const commandId = this.keymap.resolve(this.getScope(), chord);
    if (commandId !== null && this.registry.has(commandId)) {
      this.registry.run(commandId);
      return true;
    }
    return false;
  }
}
