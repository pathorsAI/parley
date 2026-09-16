import { describe, expect, it } from "vitest";
import { keyLabel, shortcutCaps } from "./caps";
import type { TranslationKey } from "../../i18n/messages";

/**
 * How a recorded trigger is spelled back to the person who recorded it.
 *
 * The property under test is that ONE stored shortcut has two readings and the
 * reader always gets their own: the modifiers already flipped per platform, but
 * the key on the end came out of a mac-only table, so a Windows user who
 * recorded Ctrl+Shift+Enter was shown "Ctrl + Shift + ↩" — three modifiers they
 * have and one key they don't.
 */

const MAC = true;
const PC = false;

/** The dictionary is irrelevant here: only the macOS-only HID-tap triggers go
 *  through `t`, and this file is about the keys that don't. Echoing the key
 *  keeps a missed lookup visible instead of silently empty. */
const t = (k: TranslationKey): string => k;

describe("a recorded key is spelled in the host keyboard's own alphabet", () => {
  it("prints the mac glyph on macOS and the printed word on Windows", () => {
    for (const [code, glyph] of [
      ["Enter", "↩"],
      ["Backspace", "⌫"],
      ["Delete", "⌦"],
      ["Tab", "⇥"],
    ] as const) {
      expect(keyLabel(code, MAC)).toBe(glyph);
      expect(keyLabel(code, PC)).toBe(code);
    }
  });

  it("spells the navigation block out for everybody", () => {
    // Shared with the cheat sheet (lib/commands/format.ts): ↖ ↘ ⇞ ⇟ are on no
    // keycap Apple ships either, so the words win on both platforms.
    for (const mac of [MAC, PC]) {
      expect(keyLabel("Home", mac)).toBe("Home");
      expect(keyLabel("End", mac)).toBe("End");
      expect(keyLabel("PageUp", mac)).toBe("PgUp");
      expect(keyLabel("PageDown", mac)).toBe("PgDn");
    }
  });

  it("reads the same on both platforms for keys that look the same on both", () => {
    for (const mac of [MAC, PC]) {
      expect(keyLabel("ArrowUp", mac)).toBe("↑");
      expect(keyLabel("ArrowDown", mac)).toBe("↓");
      expect(keyLabel("ArrowLeft", mac)).toBe("←");
      expect(keyLabel("ArrowRight", mac)).toBe("→");
      expect(keyLabel("Space", mac)).toBe("Space");
      expect(keyLabel("Escape", mac)).toBe("Esc");
    }
  });

  it("turns a code token into the character the key is printed with", () => {
    // The `code` names a position, not a legend: "Semicolon" is the key, ";" is
    // what you read off it.
    expect(keyLabel("KeyD", MAC)).toBe("D");
    expect(keyLabel("Digit7", MAC)).toBe("7");
    expect(keyLabel("Numpad5", MAC)).toBe("Num 5");
    expect(keyLabel("Semicolon", MAC)).toBe(";");
    expect(keyLabel("Backquote", MAC)).toBe("`");
    expect(keyLabel("Slash", PC)).toBe("/");
  });

  it("keeps an unknown token rather than inventing a cap for it", () => {
    // A function key or a layout-specific key we have no legend for: its token
    // is at least an honest description of which key was pressed.
    expect(keyLabel("F13", MAC)).toBe("F13");
    expect(keyLabel("IntlBackslash", PC)).toBe("IntlBackslash");
  });
});

describe("shortcutCaps renders a whole stored shortcut, modifiers and key together", () => {
  it("gives the same combo two readings, one per platform", () => {
    expect(shortcutCaps("combo:control+shift+Enter", t, MAC)).toBe("⌃ ⇧ ↩");
    expect(shortcutCaps("combo:control+shift+Enter", t, PC)).toBe("Ctrl + Shift + Enter");
  });

  it("does not leave a mac glyph behind on the key when the modifiers turn into words", () => {
    // The regression this file exists for: the modifier map was platform-aware
    // from #352 and the key label was not, so exactly one cap stayed mac.
    expect(shortcutCaps("combo:super+shift+Backspace", t, PC)).toBe("Win + Shift + Backspace");
    expect(shortcutCaps("combo:alt+PageDown", t, PC)).toBe("Alt + PgDn");
    expect(shortcutCaps("combo:super+shift+KeyD", t, PC)).toBe("Win + Shift + D");
  });

  it("keeps the two shorthands that are not combos readable on both", () => {
    expect(shortcutCaps("alt-space", t, MAC)).toBe("⌥ Space");
    expect(shortcutCaps("alt-space", t, PC)).toBe("Alt + Space");
    // The HID-tap modifiers exist only on macOS, so only macOS gets a label.
    expect(shortcutCaps("right-option", t, MAC)).toBe("settings.voiceTyping.shortcut.right-option");
    expect(shortcutCaps("right-option", t, PC)).toBe("right-option");
  });
});
