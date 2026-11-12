/**
 * Keyboard chords in one canonical string form shared with the native
 * shortcut monitor (`MachinewrightShortcutsModule.swift`): modifiers in the
 * fixed order Cmd, Ctrl, Alt, Shift, then the key, joined with "+" — e.g.
 * "Cmd+Shift+P". Single-character keys are upper-case; named keys are
 * "Escape", "Enter", "Tab", "Space", "Up", "Down", "Left", "Right".
 */

const MODIFIER_ORDER = ["Cmd", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: "Cmd",
  command: "Cmd",
  meta: "Cmd",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
};

const NAMED_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

const MODIFIER_GLYPH: Record<Modifier, string> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_GLYPH: Record<string, string> = {
  Escape: "⎋",
  Enter: "↩",
  Tab: "⇥",
  Space: "␣",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** Normalizes a human-written chord ("cmd+shift+p") to canonical form; throws on a chord with no key. */
export function canonicalChord(chord: string): string {
  const modifiers = new Set<Modifier>();
  let key: string | null = null;
  for (const raw of chord.split("+").map((part) => part.trim()).filter(Boolean)) {
    const modifier = MODIFIER_ALIASES[raw.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
    } else if (key === null) {
      key = NAMED_KEYS[raw.toLowerCase()] ?? raw.toUpperCase();
    } else {
      throw new Error(`chord "${chord}" has more than one non-modifier key`);
    }
  }
  if (key === null) throw new Error(`chord "${chord}" has no key`);
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

/** Renders a canonical chord with macOS glyphs, e.g. "Cmd+Shift+P" -> "⇧⌘P" (macOS orders ⌃⌥⇧⌘). */
export function formatChord(chord: string): string {
  const parts = canonicalChord(chord).split("+");
  const key = parts[parts.length - 1] ?? "";
  const modifiers = new Set(parts.slice(0, -1));
  const glyphs = (["Ctrl", "Alt", "Shift", "Cmd"] as const)
    .filter((modifier) => modifiers.has(modifier))
    .map((modifier) => MODIFIER_GLYPH[modifier]);
  return glyphs.join("") + (KEY_GLYPH[key] ?? key);
}
