import type { ShortcutSpec } from "../shortcuts";
import type { TranslationKey } from "../../i18n/messages";

/**
 * THE list of Parley's keyboard commands — one table, read by everything that
 * needs to know a key exists.
 *
 * Before this, "what shortcuts does this app have" was answerable only by
 * grepping five files (a hook, two bare `keydown` listeners, a React
 * `onKeyDown`, and Rust). That is fine right up until you want to SHOW the
 * list: a hand-written cheat sheet is a second copy of the truth, and the copy
 * starts lying the first time a key moves. So the sheet is generated from here,
 * and so is the macOS menu bar's accelerator set.
 *
 * This module is deliberately DATA — no store, no DOM, no React. That is what
 * lets {@link findConflicts} run in the plain-Node unit suite, and what keeps
 * the table honest: a row cannot quietly grow behaviour that the sheet can't
 * describe.
 *
 * Behaviour lives next door, in ./bind.ts (module-level handlers) or in the
 * component that owns the thing being acted on (see {@link CommandDef.run}).
 */

/**
 * WHERE a command is live. Not decoration: the same physical key means
 * different things in different places — bare ← moves the selection in a list
 * and rewinds five seconds on a recording — so a flat table cannot express the
 * app's real keymap.
 *
 * `global`  — every window, installed before React mounts.
 * `main`    — the main window's shell (so: not Settings, not the Field Log).
 * `replay`  — only while a recording's replay workbench is on screen.
 */
export type CommandScope = "global" | "main" | "replay";

/** How the cheat sheet groups rows. Presentation, not behaviour. */
export type CommandGroup = "global" | "nav" | "meeting" | "replay" | "voice";

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  "global",
  "nav",
  "meeting",
  "replay",
  "voice",
] as const;

/**
 * One chord of one command. A command may have several (⌘[ and ⌘← are the same
 * command), which is why this is a list rather than a field.
 */
export interface Chord extends ShortcutSpec {
  /**
   * The muda accelerator string, set when this EXACT chord is also claimed by
   * the macOS menu bar (see src-tauri/src/menu.rs).
   *
   * It exists to prevent a double fire. An NSMenu key equivalent is matched by
   * AppKit before the event ever reaches the webview, so on macOS a chord with
   * an accelerator must NOT also be bound here — otherwise the day WKWebView
   * does see it, ⌘1 navigates twice. Off macOS there is no menu bar claiming
   * anything, so the webview binds it normally.
   *
   * Per-CHORD rather than per-command on purpose: ⌘= is in the View menu but
   * ⌘⇧+ (the same zoom, one keyboard layout over) is not, and the second one
   * still has to work.
   */
  native?: string;
  /**
   * A second SPELLING of the same physical key, not a second way to reach the
   * command. ⌘= and ⌘+ are one key with and without shift; ⌘[ and ⌘← are two
   * genuinely different keys.
   *
   * Both are bound. Only the non-alias is printed — a cheat sheet that offers
   * "⌘= / ⌘+" for one row makes the reader stop and work out the difference,
   * and there isn't one.
   */
  alias?: true;
}

interface CommandShape {
  group: CommandGroup;
  scope: CommandScope;
  keys: readonly Chord[];
  labelKey: TranslationKey;
  /**
   * Fire even while focus is in a text field. Only for commands that are ABOUT
   * the field (⌘F re-focuses the find box that already has focus) or that must
   * be able to dismiss the very thing holding focus (⌘K closes the palette
   * whose search input is focused).
   */
  whileTyping?: boolean;
  /**
   * Listed in the cheat sheet, never bound by the webview — something else
   * already owns the key. `os` is the window manager / Tauri's default menu;
   * `native-hotkey` is the Rust global shortcut, which works even when Parley
   * is not the frontmost app.
   */
  ownedBy?: "os" | "native-hotkey";
  /**
   * The chord is a user setting, so it can't be written down here. The sheet
   * resolves it at render time; the table still owns the ROW.
   */
  dynamicKeys?: "voiceTyping";
}

const MOD = { mod: true } as const;

/**
 * The table. Order inside a group is the order the cheat sheet prints.
 *
 * Where a row has no handler in ./bind.ts, a component owns the behaviour and
 * binds it with `useCommandShortcut` — the KEYS are still only stated here.
 */
const TABLE = [
  // ── global ──────────────────────────────────────────────────────────────
  {
    id: "settings.open",
    group: "global",
    scope: "global",
    keys: [{ ...MOD, key: ",", native: "CmdOrCtrl+," }],
    labelKey: "cmd.settings.open",
  },
  {
    id: "shortcuts.show",
    group: "global",
    scope: "global",
    // No `mod`, and shift deliberately unconstrained — see ShortcutSpec.shift.
    // `whileTyping` is off: "?" is a character, and a cheat sheet that opens
    // mid-sentence while you name a folder is worse than no cheat sheet.
    keys: [{ key: "?", shift: "any", native: "Shift+Slash" }],
    labelKey: "cmd.shortcuts.show",
  },
  {
    id: "window.close",
    group: "global",
    scope: "global",
    // Tauri's default menu already carries Close Window in both the File and
    // Window submenus, so this row is here to be LISTED, not to be bound.
    keys: [{ ...MOD, key: "w" }],
    labelKey: "cmd.window.close",
    ownedBy: "os",
  },
  {
    id: "zoom.in",
    group: "global",
    scope: "global",
    keys: [
      { ...MOD, key: "=", native: "CmdOrCtrl+=" },
      // The shifted spelling of the same key. The menu claims ⌘= only, so this
      // one stays webview-bound on every platform.
      { ...MOD, key: "+", shift: "any", alias: true },
    ],
    labelKey: "cmd.zoom.in",
  },
  {
    id: "zoom.out",
    group: "global",
    scope: "global",
    keys: [
      { ...MOD, key: "-", native: "CmdOrCtrl+-" },
      { ...MOD, key: "_", shift: "any", alias: true },
    ],
    labelKey: "cmd.zoom.out",
  },
  {
    id: "zoom.reset",
    group: "global",
    scope: "global",
    keys: [{ ...MOD, key: "0", native: "CmdOrCtrl+0" }],
    labelKey: "cmd.zoom.reset",
  },

  // ── navigation (main window) ────────────────────────────────────────────
  {
    id: "nav.jumpTo",
    group: "nav",
    scope: "main",
    keys: [{ ...MOD, key: "k", native: "CmdOrCtrl+K" }],
    labelKey: "cmd.nav.jumpTo",
    whileTyping: true,
  },
  {
    id: "nav.back",
    group: "nav",
    scope: "main",
    keys: [
      { ...MOD, key: "[", native: "CmdOrCtrl+[" },
      { ...MOD, key: "ArrowLeft" },
    ],
    labelKey: "cmd.nav.back",
  },
  {
    id: "nav.forward",
    group: "nav",
    scope: "main",
    keys: [
      { ...MOD, key: "]", native: "CmdOrCtrl+]" },
      { ...MOD, key: "ArrowRight" },
    ],
    labelKey: "cmd.nav.forward",
  },
  {
    id: "nav.home",
    group: "nav",
    scope: "main",
    keys: [{ ...MOD, key: "1", native: "CmdOrCtrl+1" }],
    labelKey: "cmd.nav.home",
  },
  {
    id: "nav.library",
    group: "nav",
    scope: "main",
    keys: [{ ...MOD, key: "2", native: "CmdOrCtrl+2" }],
    labelKey: "cmd.nav.library",
  },
  {
    id: "nav.study",
    group: "nav",
    scope: "main",
    keys: [{ ...MOD, key: "3", native: "CmdOrCtrl+3" }],
    labelKey: "cmd.nav.study",
  },
  {
    id: "view.toggleSidebar",
    group: "nav",
    scope: "main",
    keys: [{ ...MOD, key: "b", native: "CmdOrCtrl+B" }],
    labelKey: "cmd.view.toggleSidebar",
  },

  // ── meeting (main window) ───────────────────────────────────────────────
  {
    id: "meeting.start",
    group: "meeting",
    scope: "main",
    // START only. Ending a meeting is not undoable, and ⌘R is the most
    // reflexively-pressed chord on the platform ("reload") — someone reaching
    // for a refresh must not stop a recording that is running. Ending stays a
    // button you have to look at.
    keys: [{ ...MOD, key: "r", native: "CmdOrCtrl+R" }],
    labelKey: "cmd.meeting.start",
  },
  {
    id: "meeting.togglePause",
    group: "meeting",
    scope: "main",
    keys: [{ ...MOD, shift: true, key: "p", native: "Shift+CmdOrCtrl+P" }],
    labelKey: "cmd.meeting.togglePause",
  },

  // ── replay workbench ────────────────────────────────────────────────────
  {
    id: "replay.togglePlay",
    group: "replay",
    scope: "replay",
    keys: [{ key: " " }],
    labelKey: "cmd.replay.togglePlay",
  },
  {
    id: "replay.back5",
    group: "replay",
    scope: "replay",
    keys: [{ key: "ArrowLeft" }],
    labelKey: "cmd.replay.back5",
  },
  {
    id: "replay.forward5",
    group: "replay",
    scope: "replay",
    keys: [{ key: "ArrowRight" }],
    labelKey: "cmd.replay.forward5",
  },
  {
    id: "replay.back10",
    group: "replay",
    scope: "replay",
    keys: [{ shift: true, key: "ArrowLeft" }],
    labelKey: "cmd.replay.back10",
  },
  {
    id: "replay.forward10",
    group: "replay",
    scope: "replay",
    keys: [{ shift: true, key: "ArrowRight" }],
    labelKey: "cmd.replay.forward10",
  },
  {
    id: "replay.toStart",
    group: "replay",
    scope: "replay",
    keys: [{ key: "Home" }],
    labelKey: "cmd.replay.toStart",
  },
  {
    id: "replay.toEnd",
    group: "replay",
    scope: "replay",
    keys: [{ key: "End" }],
    labelKey: "cmd.replay.toEnd",
  },
  {
    id: "replay.find",
    group: "replay",
    scope: "replay",
    keys: [{ ...MOD, key: "f" }],
    labelKey: "cmd.replay.find",
    // Must keep working once the find field it opens has focus.
    whileTyping: true,
  },

  // ── voice typing ────────────────────────────────────────────────────────
  {
    id: "voice.pushToTalk",
    group: "voice",
    scope: "global",
    keys: [],
    labelKey: "cmd.voice.pushToTalk",
    ownedBy: "native-hotkey",
    dynamicKeys: "voiceTyping",
  },
] as const;

/** Derived from the table, never hand-written — an id that is not in
 *  {@link COMMANDS} must not type-check at a call site. */
export type CommandId = (typeof TABLE)[number]["id"];

export interface CommandDef extends CommandShape {
  id: CommandId;
}

/** The table, checked against {@link CommandDef}. A row with a typo'd group,
 *  scope or label key fails here rather than at the sheet that renders it. */
export const COMMANDS: readonly CommandDef[] = TABLE;

const BY_ID = new Map<CommandId, CommandDef>(COMMANDS.map((c) => [c.id, c]));

/** Look a command up. Throws rather than returning undefined: every call site
 *  passes a literal id, so a miss is a typo, and a silently unbound shortcut is
 *  the exact failure this table exists to prevent. */
export function command(id: CommandId): CommandDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown command: ${id}`);
  return found;
}

/** Every command a given scope is responsible for installing. */
export function commandsInScope(scope: CommandScope): CommandDef[] {
  return COMMANDS.filter((c) => c.scope === scope);
}

/** Cheat-sheet input: the commands of one group, in table order. */
export function commandsInGroup(group: CommandGroup): CommandDef[] {
  return COMMANDS.filter((c) => c.group === group);
}

/** A chord's identity for conflict comparison. Modifier state is part of it —
 *  ⌘K and ⇧⌘K are different keys — and `"any"` shift is folded to `*` because
 *  it collides with BOTH shifted and unshifted spellings of the same key. */
export function chordKey(chord: Chord): string {
  return [
    chord.mod ? "1" : "0",
    shiftSlot(chord.shift),
    chord.alt ? "1" : "0",
    chord.key.toLowerCase(),
  ].join("+");
}

/** The shift slot of a {@link chordKey}. `"any"` becomes a wildcard rather than
 *  a value, so a shift-agnostic chord is seen to collide with BOTH the shifted
 *  and the unshifted spelling of the same key. */
function shiftSlot(shift: Chord["shift"]): string {
  if (shift === "any") return "*";
  return shift ? "1" : "0";
}

export interface Conflict {
  chord: string;
  ids: CommandId[];
}

/**
 * Two bindable commands claiming the same chord.
 *
 * There is no scope arithmetic here because today every scope NESTS: `replay`
 * lives inside `main`, and `main` inside the window that `global` covers. So a
 * chord claimed twice is a conflict wherever the two sit. The day a scope gains
 * a sibling (a `library` beside `replay`, say), this is where the comparison
 * has to learn about it — and the test below is where it will fail first.
 *
 * Commands the webview never binds are excluded: ⌘W is listed for the sheet's
 * benefit and claimed by Tauri's default menu, so it collides with nothing.
 */
export function findConflicts(): Conflict[] {
  const byChord = new Map<string, CommandId[]>();
  for (const c of COMMANDS) {
    if (c.ownedBy) continue;
    for (const chord of c.keys) {
      const k = chordKey(chord);
      const ids = byChord.get(k) ?? [];
      if (!ids.includes(c.id)) ids.push(c.id);
      byChord.set(k, ids);
    }
  }
  return [...byChord]
    .filter(([, ids]) => ids.length > 1)
    .map(([chord, ids]) => ({ chord, ids }));
}
