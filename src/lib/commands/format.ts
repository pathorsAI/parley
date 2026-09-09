import type { Chord } from "./registry";

/**
 * A chord, spelled the way a keyboard shows it.
 *
 * Printing is the mirror image of matching, and the two must not drift: the
 * cheat sheet promising ⌘[ while {@link matchShortcut} listens for something
 * else is exactly the lie a generated sheet exists to prevent. So this module
 * reads the SAME {@link Chord} the binder does, and stays as pure as
 * shortcuts.ts — no React, no DOM, no platform lookup — which is what lets both
 * spellings be proven in the plain-Node unit suite.
 */

/**
 * Keys whose `KeyboardEvent.key` name is not what the keycap says. Everything
 * absent is printed verbatim, which is right for the punctuation the table uses
 * (",", "[", "]", "?", "=", "+", "-", "0") and for "Home"/"End" — those already
 * say themselves, and the macOS ↖/↘ glyphs are recognised by far fewer people
 * than the words are.
 */
const KEY_CAPS: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Escape: "Esc",
};

/** One key's cap. Single characters are upper-cased so the table's "k" prints
 *  as the K that is actually engraved on the key; punctuation is unaffected by
 *  that (`",".toUpperCase()` is ","). */
export function formatKey(key: string): string {
  const named = KEY_CAPS[key];
  if (named) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The key caps of one chord, in press order.
 *
 * Order follows the platform's own convention, because that is what a user
 * recognises at a glance: macOS puts the Command key LAST (⌥⇧⌘P) while Windows
 * puts Ctrl FIRST (Ctrl+Alt+Shift+P). `mod` is the key that moves — it is ⌘ on
 * one and Ctrl on the other — so it is the only cap whose position depends on
 * `mac`. ({@link ShortcutSpec} has no standalone control modifier, so macOS's
 * leading ⌃ slot is simply never filled; the day one appears it goes in front
 * of ⌥ on mac and after Ctrl off it.)
 *
 * `shift: "any"` deliberately prints NO ⇧. That value means the shift state is
 * not the user's choice — "?" is unshifted on some layouts and shifted on
 * others (see ShortcutSpec.shift) — so a ⇧ cap would be wrong on half of all
 * keyboards. The rows that use it read correctly regardless: `shortcuts.show`
 * prints "?", whose cap already implies whatever shift that layout needs, and
 * zoom's ⌘+ / ⌘_ likewise carry the shifted character itself.
 *
 * `mac` is a parameter rather than a call to {@link isMac} so both spellings
 * are testable without stubbing the OS — the same seam {@link matchShortcut}
 * uses.
 */
export function formatChord(chord: Chord, mac: boolean): string[] {
  const caps: string[] = [];
  if (chord.mod && !mac) caps.push("Ctrl");
  if (chord.alt) caps.push(mac ? "⌥" : "Alt");
  if (chord.shift === true) caps.push(mac ? "⇧" : "Shift");
  if (chord.mod && mac) caps.push("⌘");
  caps.push(formatKey(chord.key));
  return caps;
}
