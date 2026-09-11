import { command, type CommandId } from "../commands/registry";
import { matchShortcut, type KeyStroke } from "../shortcuts";
import { isMac } from "../platform";

/**
 * Where the playhead lands for each of replay's seek commands — the one copy.
 *
 * Two things reach for this arithmetic: the window-wide bindings the replay
 * workbench installs while it is on screen, and the scrubber's own `onKeyDown`,
 * which still has to answer when the slider itself holds focus. Written twice
 * they drift at the edges — one clamps, the other doesn't — and "back five
 * seconds" quietly means two different things depending on where you last
 * clicked. So it is written once, here, as arithmetic over numbers with no DOM
 * in sight.
 *
 * The clock is the PLAYHEAD's, not the audio file's: 0 is the start of the kept
 * window and `durationMs` is its end. A trim never touches the file — it rebases
 * the transcript onto a fresh 0-based timeline and shifts `audioOffsetMs`
 * instead (see ./trim.ts) — and `useReplayPlayer.seek` adds that offset back on
 * the way to `audio.currentTime`. So the trim window really is 0..durationMs in
 * the only coordinates this module, the scrubber and `player.seek` speak, and
 * Home lands on the first kept second rather than on the cut-away intro.
 */

const SHORT_STEP_MS = 5_000;
const LONG_STEP_MS = 10_000;

/** The rows of the command table this module can answer for. `satisfies` is the
 *  point: renaming a command in the registry breaks here, not at runtime. */
export const SEEK_COMMANDS = [
  "replay.back5",
  "replay.forward5",
  "replay.back10",
  "replay.forward10",
  "replay.toStart",
  "replay.toEnd",
] as const satisfies readonly CommandId[];

export type SeekCommandId = (typeof SEEK_COMMANDS)[number];

/** Unclamped intent, one line each; {@link seekTarget} owns the clamping so no
 *  row can forget it. */
const MOVES: Record<SeekCommandId, (playheadMs: number, endMs: number) => number> = {
  "replay.back5": (ms) => ms - SHORT_STEP_MS,
  "replay.forward5": (ms) => ms + SHORT_STEP_MS,
  "replay.back10": (ms) => ms - LONG_STEP_MS,
  "replay.forward10": (ms) => ms + LONG_STEP_MS,
  "replay.toStart": () => 0,
  "replay.toEnd": (_ms, endMs) => endMs,
};

/**
 * The position `id` asks for, clamped into the kept window. A recording whose
 * duration isn't known yet reports 0, which collapses the window to a point —
 * that is the honest answer, not a reason to let the playhead run off the end.
 */
export function seekTarget(id: SeekCommandId, playheadMs: number, durationMs: number): number {
  const endMs = Math.max(0, durationMs);
  return Math.max(0, Math.min(endMs, MOVES[id](playheadMs, endMs)));
}

/**
 * The same answer for a raw keystroke, or null if the key means nothing here.
 *
 * For the scrubber, which is a focused widget rather than a window-wide binding
 * and so never passes through the shortcut listener. It asks the command table
 * what the stroke means instead of restating ← and ⇧← itself — the chords stay
 * spelled out in exactly one file, and a bare ← that arrives with ⌘ held is left
 * alone for the navigation command that owns it.
 */
export function seekTargetForKey(
  e: KeyStroke,
  playheadMs: number,
  durationMs: number,
  mac: boolean = isMac()
): number | null {
  for (const id of SEEK_COMMANDS) {
    if (command(id).keys.some((chord) => matchShortcut(e, chord, mac))) {
      return seekTarget(id, playheadMs, durationMs);
    }
  }
  return null;
}
