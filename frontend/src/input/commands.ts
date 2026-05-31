/**
 * commands.ts — Abstract command objects and a registry.
 *
 * A Command is an addressable, named unit of behavior (vscode's command
 * palette model). Bindings reference commands by `id` only — the binding layer
 * never knows what a command does. The app registers concrete implementations
 * at startup, keeping this core free of app/DOM assumptions.
 */

export interface Command {
  /** Stable, namespaced identifier, e.g. "cursor.down". */
  id: string;
  /** Human-readable title (for a future command palette). */
  title: string;
  /** Side-effecting implementation; may be async. */
  run(): void | Promise<void>;
}

/**
 * In-memory map of command id → Command. Tolerant by design: running an
 * unknown id warns and no-ops rather than throwing, so a stray binding can
 * never crash input handling.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  /** Register (or overwrite) a command by its id. */
  register(cmd: Command): void {
    this.commands.set(cmd.id, cmd);
  }

  /** True if a command with this id is registered. */
  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** Run a command by id. Unknown ids warn and no-op (never throw). */
  run(id: string): void {
    const cmd = this.commands.get(id);
    if (!cmd) {
      console.warn(`[input] no command registered for id "${id}"`);
      return;
    }
    // Fire-and-forget; swallow rejections so input handling stays robust.
    void Promise.resolve(cmd.run()).catch((err) => {
      console.error(`[input] command "${id}" threw`, err);
    });
  }

  /** Snapshot of all registered commands (for a palette / introspection). */
  list(): Command[] {
    return [...this.commands.values()];
  }
}
