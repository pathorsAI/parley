import { describe, expect, it } from "vitest";
import { formatChord, formatChordLabel, modChordCap, formatKey } from "./format";
import type { Chord } from "./registry";

/**
 * What the cheat sheet is allowed to claim. Two properties matter: the caps
 * name the keys the matcher actually listens for, and they never assert a
 * modifier the chord did not fix (see the `shift: "any"` cases at the bottom —
 * that is the one place printing could quietly start lying).
 */

const MAC = true;
const PC = false;

describe("formatChord", () => {
  it("spells mod as ⌘ on macOS and Ctrl elsewhere", () => {
    const cmdK: Chord = { mod: true, key: "k" };
    expect(formatChord(cmdK, MAC)).toEqual(["⌘", "K"]);
    expect(formatChord(cmdK, PC)).toEqual(["Ctrl", "K"]);
  });

  it("spells alt and shift for the platform too", () => {
    const chord: Chord = { alt: true, shift: true, key: "p" };
    expect(formatChord(chord, MAC)).toEqual(["⌥", "⇧", "P"]);
    expect(formatChord(chord, PC)).toEqual(["Alt", "Shift", "P"]);
  });

  it("orders modifiers by the platform's own convention, key last", () => {
    // Declared out of order on purpose: the output order is the platform's, not
    // the order the fields happen to appear in. macOS trails the Command key
    // (⌥⇧⌘P); Windows leads with Ctrl (Ctrl+Alt+Shift+P). Getting this backwards
    // is not a crash, just a cheat sheet that reads as foreign on one platform.
    const chord: Chord = { mod: true, shift: true, alt: true, key: "p" };
    expect(formatChord(chord, MAC)).toEqual(["⌥", "⇧", "⌘", "P"]);
    expect(formatChord(chord, PC)).toEqual(["Ctrl", "Alt", "Shift", "P"]);
  });

  it("prints the arrows and space as glyphs, not event names", () => {
    expect(formatChord({ key: " " }, MAC)).toEqual(["Space"]);
    expect(formatChord({ key: "ArrowLeft" }, MAC)).toEqual(["←"]);
    expect(formatChord({ key: "ArrowRight" }, MAC)).toEqual(["→"]);
    expect(formatChord({ key: "ArrowUp" }, MAC)).toEqual(["↑"]);
    expect(formatChord({ key: "ArrowDown" }, MAC)).toEqual(["↓"]);
    expect(formatChord({ mod: true, key: "ArrowLeft" }, MAC)).toEqual(["⌘", "←"]);
  });

  it("upper-cases a letter and leaves everything else verbatim", () => {
    expect(formatKey("k", MAC)).toBe("K");
    // Punctuation and digits have no case to change.
    for (const key of [",", "[", "]", "?", "=", "+", "-", "0"]) {
      expect(formatKey(key, MAC)).toBe(key);
      expect(formatKey(key, PC)).toBe(key);
    }
    expect(formatKey("Escape", MAC)).toBe("Esc");
    expect(formatKey("Escape", PC)).toBe("Esc");
  });

  it("prints no shift cap for `shift: \"any\"`, on either platform", () => {
    // The shift state is the layout's business there, not the user's, so a ⇧
    // would be wrong on every keyboard where "?" is unshifted. The "?" cap
    // carries the whole instruction on its own.
    expect(formatChord({ key: "?", shift: "any" }, MAC)).toEqual(["?"]);
    expect(formatChord({ key: "?", shift: "any" }, PC)).toEqual(["?"]);
    // Same for the shifted spelling of zoom: ⌘+ prints as ⌘ and +.
    expect(formatChord({ mod: true, key: "+", shift: "any" }, MAC)).toEqual(["⌘", "+"]);
    // …while a chord that DOES fix shift still says so.
    expect(formatChord({ shift: true, key: "ArrowLeft" }, MAC)).toEqual(["⇧", "←"]);
  });

  it("ignores the menu-bar accelerator — that is a binding fact, not a cap", () => {
    const chord: Chord = { mod: true, key: "1", native: "CmdOrCtrl+1" };
    expect(formatChord(chord, MAC)).toEqual(["⌘", "1"]);
  });
});

describe("a key cap is the glyph the host keyboard actually prints", () => {
  it("gives macOS its glyphs and Windows the word on the same keycap", () => {
    for (const [key, glyph] of [
      ["Enter", "↩"],
      ["Backspace", "⌫"],
      ["Delete", "⌦"],
      ["Tab", "⇥"],
    ] as const) {
      expect(formatKey(key, MAC)).toBe(glyph);
      // No Windows table to get out of step: the `KeyboardEvent.key` name IS
      // the word a PC keycap carries.
      expect(formatKey(key, PC)).toBe(key);
    }
  });

  it("spells the navigation block out on both platforms, glyphs being no help", () => {
    // ↖ ↘ ⇞ ⇟ appear on no keyboard either vendor ships, so they would be a
    // riddle on macOS too — the one case where both sides say the same thing.
    // The cheat sheet's replay.toStart / replay.toEnd rows are these.
    for (const mac of [MAC, PC]) {
      expect(formatKey("Home", mac)).toBe("Home");
      expect(formatKey("End", mac)).toBe("End");
      expect(formatKey("PageUp", mac)).toBe("PgUp");
      expect(formatKey("PageDown", mac)).toBe("PgDn");
    }
  });

  it("carries the platform down from the chord, not from the host OS", () => {
    // formatChord must not consult isMac() behind its caller's back: the cap
    // and the modifiers in front of it have to come from the same platform, or
    // a sheet rendered for one reads half in the other's alphabet.
    expect(formatChord({ mod: true, shift: true, key: "Enter" }, MAC)).toEqual(["⇧", "⌘", "↩"]);
    expect(formatChord({ mod: true, shift: true, key: "Enter" }, PC)).toEqual([
      "Ctrl",
      "Shift",
      "Enter",
    ]);
  });

  it("spells the dictionary bubble's Alt+Enter for the platform it renders on", () => {
    // voice-typing's "add to dictionary" hint (host.ts SUGGEST_SHORTCUT). It
    // was a translated string reading "⌥↩" in both locales until this became
    // computed.
    expect(formatChordLabel({ alt: true, key: "Enter" }, MAC)).toBe("⌥↩");
    expect(formatChordLabel({ alt: true, key: "Enter" }, PC)).toBe("Alt+Enter");
  });
});

describe("modChordCap", () => {
  // The chords work on both platforms; it was only the LABELS that were
  // written mac-first, which is how a Windows user ended up being told to
  // press a glyph that is not on their keyboard.
  it("spells a chord the way the host OS spells it", () => {
    expect(modChordCap("F", true)).toBe("⌘F");
    expect(modChordCap("F", false)).toBe("Ctrl+F");
    expect(modChordCap("V", false)).toBe("Ctrl+V");
  });
});
