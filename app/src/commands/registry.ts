/**
 * The application's command registry: every action reachable from the
 * command palette or a keyboard shortcut is one `Command`. The registry
 * owns no UI and no application state — commands close over whatever they
 * need — so the shell can rebuild the list as state changes (e.g. a command
 * that needs an open project reports itself disabled via `enabled`).
 */
import { canonicalChord } from "./chords";

export interface Command {
  /** Stable identifier, e.g. "file.open". */
  readonly id: string;
  /** Palette label, e.g. "Open Project…". */
  readonly title: string;
  /** Palette grouping shown as a prefix, e.g. "File". */
  readonly category?: string;
  /** Chord in any spelling `canonicalChord` accepts, e.g. "Cmd+Shift+P". */
  readonly shortcut?: string;
  /** Defaults to true; a disabled command is hidden from the palette and its shortcut is ignored. */
  readonly enabled?: boolean;
  run(): void | Promise<void>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly byChord = new Map<string, string>();

  constructor(commands: readonly Command[] = []) {
    for (const command of commands) this.register(command);
  }

  register(command: Command): void {
    if (this.commands.has(command.id)) throw new Error(`duplicate command id: ${command.id}`);
    if (command.shortcut) {
      const chord = canonicalChord(command.shortcut);
      const owner = this.byChord.get(chord);
      if (owner) throw new Error(`shortcut ${chord} is bound to both ${owner} and ${command.id}`);
      this.byChord.set(chord, command.id);
    }
    this.commands.set(command.id, command);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** Commands that can currently run, in registration order. */
  listEnabled(): readonly Command[] {
    return [...this.commands.values()].filter((command) => command.enabled !== false);
  }

  /** Canonical chords of every command with a shortcut (enabled or not). */
  shortcutChords(): readonly string[] {
    return [...this.byChord.keys()];
  }

  /**
   * Chords worth intercepting right now: only enabled commands', so a
   * disabled command's key combination still reaches whatever surface had it
   * (e.g. Cmd+F in the terminal when no document is open).
   */
  enabledShortcutChords(): readonly string[] {
    return [...this.byChord.entries()]
      .filter(([, id]) => this.commands.get(id)?.enabled !== false)
      .map(([chord]) => chord);
  }

  /** Runs the enabled command bound to `chord`; returns whether one ran. Rejections surface through the returned promise. */
  async runChord(chord: string): Promise<boolean> {
    const id = this.byChord.get(canonicalChord(chord));
    const command = id ? this.commands.get(id) : undefined;
    if (!command || command.enabled === false) return false;
    await command.run();
    return true;
  }

  async run(id: string): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command || command.enabled === false) return false;
    await command.run();
    return true;
  }
}
