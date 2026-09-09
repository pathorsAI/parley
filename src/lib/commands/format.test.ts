import { describe, expect, it } from "vitest";
import { formatChord, formatKey } from "./format";
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
    expect(formatKey("k")).toBe("K");
    // Punctuation and digits have no case to change.
    for (const key of [",", "[", "]", "?", "=", "+", "-", "0"]) {
      expect(formatKey(key)).toBe(key);
    }
    // Named keys that already read as themselves keep their word.
    expect(formatKey("Home")).toBe("Home");
    expect(formatKey("End")).toBe("End");
    expect(formatKey("Enter")).toBe("↩");
    expect(formatKey("Escape")).toBe("Esc");
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

