import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  COMMAND_GROUPS,
  chordKey,
  command,
  commandsInGroup,
  commandsInScope,
  findConflicts,
  type CommandDef,
} from "./registry";
import { matchShortcut } from "../shortcuts";
import { DICTS } from "../../i18n/messages";

/**
 * The table is only worth having if it is provably the whole truth, so these
 * are the properties the rest of the system leans on: no chord claimed twice,
 * every row printable in both languages, and the two chords that look like they
 * collide (⌘← vs bare ←) genuinely not colliding.
 */

describe("command registry", () => {
  it("claims no chord twice", () => {
    // The one property a hand-maintained cheat sheet could never guarantee.
    // A failure here names the two commands — fix the table, not this test.
    expect(findConflicts()).toEqual([]);
  });

  it("gives every command a label in both dictionaries", () => {
    // The repo rule is zh-TW and en, both first-class. A row with a label only
    // in English renders as a raw key in the Chinese cheat sheet.
    for (const def of COMMANDS) {
      expect(DICTS["zh-TW"][def.labelKey], `zh-TW: ${def.id}`).toBeTruthy();
      expect(DICTS.en[def.labelKey], `en: ${def.id}`).toBeTruthy();
    }
  });

  it("has a unique id per row", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only omits chords for rows that say where the chord comes from", () => {
    // An empty `keys` is legitimate exactly twice over: the key belongs to
    // something else (`ownedBy`), or it is a user setting resolved at render
    // (`dynamicKeys`). Any other empty row is a shortcut nobody can press.
    for (const def of COMMANDS) {
      if (def.keys.length > 0) continue;
      expect(def.ownedBy ?? def.dynamicKeys, `${def.id} has no keys and no source`).toBeTruthy();
    }
  });

  it("puts every command in a group the cheat sheet renders", () => {
    for (const def of COMMANDS) expect(COMMAND_GROUPS).toContain(def.group);
    // And no group is declared that nothing is in — an empty heading in the
    // sheet is a heading that shouldn't exist.
    for (const group of COMMAND_GROUPS) expect(commandsInGroup(group).length).toBeGreaterThan(0);
  });

  it("looks a command up by id and refuses an unknown one", () => {
    expect(command("nav.back").group).toBe("nav");
    expect(() => command("nav.nowhere" as never)).toThrow(/unknown command/);
  });

  it("partitions the table by scope", () => {
    const scoped = (["global", "main", "replay"] as const).flatMap((s) => commandsInScope(s));
    expect(scoped.length).toBe(COMMANDS.length);
  });
});

describe("chord matching against the table", () => {
  const chordsOf = (id: Parameters<typeof command>[0]) => command(id).keys;

  it("does not let ⌘← trigger the replay rewind bound to bare ←", () => {
    // The two live in overlapping scopes on the same screen, and the ONLY thing
    // keeping them apart is that a spec without `mod` refuses a stroke holding
    // it. That is load-bearing, so it is pinned here rather than assumed.
    const rewind = chordsOf("replay.back5")[0];
    const strokeWithMeta = { key: "ArrowLeft", metaKey: true };
    expect(matchShortcut(strokeWithMeta, rewind, true)).toBe(false);
    expect(matchShortcut({ key: "ArrowLeft" }, rewind, true)).toBe(true);
  });

  it("does not let bare ← trigger the ⌘← back navigation", () => {
    const back = chordsOf("nav.back").find((c) => c.key === "ArrowLeft");
    expect(back).toBeDefined();
    expect(matchShortcut({ key: "ArrowLeft" }, back as CommandDef["keys"][number], true)).toBe(
      false
    );
    expect(
      matchShortcut({ key: "ArrowLeft", metaKey: true }, back as CommandDef["keys"][number], true)
    ).toBe(true);
  });

  it("matches ⇧? whichever way the layout spells it", () => {
    // The reason ShortcutSpec.shift grew an "any": on a US layout `?` arrives
    // with shift held, elsewhere it doesn't, and neither spelling may miss.
    const [sheet] = chordsOf("shortcuts.show");
    expect(matchShortcut({ key: "?", shiftKey: true }, sheet, true)).toBe(true);
    expect(matchShortcut({ key: "?" }, sheet, true)).toBe(true);
    // Still not a free-for-all: ⌘? is a different chord and must fall through.
    expect(matchShortcut({ key: "?", shiftKey: true, metaKey: true }, sheet, true)).toBe(false);
  });

  it("keeps ⌘R off the shifted and controlled variants", () => {
    // ⌘R starts a meeting. Anything adjacent to it must NOT.
    const [start] = chordsOf("meeting.start");
    expect(matchShortcut({ key: "r", metaKey: true }, start, true)).toBe(true);
    expect(matchShortcut({ key: "r", metaKey: true, shiftKey: true }, start, true)).toBe(false);
    expect(matchShortcut({ key: "r", metaKey: true, ctrlKey: true }, start, true)).toBe(false);
    // On Windows the same row must answer to Ctrl, not to the Windows key.
    expect(matchShortcut({ key: "r", ctrlKey: true }, start, false)).toBe(true);
    expect(matchShortcut({ key: "r", metaKey: true }, start, false)).toBe(false);
  });

  it("treats a shift-agnostic chord as colliding with both spellings", () => {
    // chordKey folds `"any"` to a wildcard so findConflicts can see that a
    // shift-agnostic ⇧? would swallow a future plain `?` binding.
    expect(chordKey({ key: "?", shift: "any" })).not.toBe(chordKey({ key: "?", shift: true }));
    expect(chordKey({ key: "?", shift: "any" })).toContain("*");
  });
});

describe("macOS menu bar accelerators", () => {
  it("only puts an accelerator on a chord the webview could otherwise bind", () => {
    // A `native` string on an `ownedBy` row would mean two owners for one key.
    for (const def of COMMANDS) {
      if (!def.ownedBy) continue;
      for (const chord of def.keys) {
        expect(chord.native, `${def.id} is owned elsewhere but claims an accelerator`).toBeUndefined();
      }
    }
  });

  it("never accelerates a chord that does not carry Command", () => {
    // The invariant this file was missing, and 0.30.0 shipped without.
    //
    // AppKit matches an NSMenu key equivalent inside `sendEvent:`, BEFORE the
    // event reaches the key window's first responder. A menu item holding a
    // bare "?" therefore eats the character before any text field can see it —
    // the app stops being able to type a question mark at all. The webview's
    // typing guard cannot help, because the webview never gets the event.
    //
    // Command is what makes a chord safe to hand to a menu: nobody types ⌘?
    // into a sentence. This is also why Apple's own guidance is that every key
    // equivalent carries it.
    for (const def of COMMANDS) {
      for (const chord of def.keys) {
        if (!chord.native) continue;
        expect(
          chord.native.includes("CmdOrCtrl"),
          `${def.id} accelerates "${chord.native}", which would swallow typing`
        ).toBe(true);
        // And the accelerator must actually match the chord it is attached to.
        expect(chord.mod, `${def.id}: accelerator says Command, chord does not`).toBe(true);
      }
    }
  });

  it("never gives two commands the same accelerator", () => {
    const accelerators = COMMANDS.flatMap((c) => c.keys.map((k) => k.native)).filter(Boolean);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe("chord aliases", () => {
  it("leaves every command at least one chord the cheat sheet can print", () => {
    // An `alias` chord is suppressed in the sheet. A row where EVERY chord is
    // an alias would bind fine and then render as a label with no keys beside
    // it — worse than absent, because it reads as a bug in the app.
    for (const def of COMMANDS) {
      if (def.keys.length === 0) continue;
      expect(def.keys.some((c) => !c.alias), `${def.id} is all aliases`).toBe(true);
    }
  });

  it("never makes an alias the one the macOS menu bar claims", () => {
    // The menu shows the canonical spelling; an accelerator on the alias would
    // put ⌘+ in the View menu while the sheet promises ⌘=.
    for (const def of COMMANDS) {
      for (const chord of def.keys) {
        if (!chord.alias) continue;
        expect(chord.native, `${def.id} accelerates an alias`).toBeUndefined();
      }
    }
  });
});
