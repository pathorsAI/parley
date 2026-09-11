import { describe, expect, it } from "vitest";
import { seekTarget, seekTargetForKey } from "./seek";

/**
 * The property this module exists for: the workbench's window-wide bindings and
 * the scrubber's own onKeyDown produce the SAME position, clamped the same way,
 * for the same key. Both routes are exercised here.
 */

const MAC = true;
const DURATION = 60_000;

/** A keystroke with nothing held down; override what the case is about. */
function stroke(key: string, overrides: Record<string, boolean> = {}) {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("seekTarget", () => {
  it("steps five seconds, and ten with shift's command", () => {
    expect(seekTarget("replay.back5", 30_000, DURATION)).toBe(25_000);
    expect(seekTarget("replay.forward5", 30_000, DURATION)).toBe(35_000);
    expect(seekTarget("replay.back10", 30_000, DURATION)).toBe(20_000);
    expect(seekTarget("replay.forward10", 30_000, DURATION)).toBe(40_000);
  });

  it("clamps to the kept window instead of running off either end", () => {
    expect(seekTarget("replay.back5", 2_000, DURATION)).toBe(0);
    expect(seekTarget("replay.forward10", 58_000, DURATION)).toBe(DURATION);
    expect(seekTarget("replay.toStart", 42_000, DURATION)).toBe(0);
    expect(seekTarget("replay.toEnd", 0, DURATION)).toBe(DURATION);
  });

  it("collapses to 0 while the duration is still unknown", () => {
    // Metadata hasn't loaded; there is no window to move inside yet.
    expect(seekTarget("replay.forward5", 0, 0)).toBe(0);
    expect(seekTarget("replay.toEnd", 0, 0)).toBe(0);
  });

  it("measures from the start of the TRIM window, not the audio file", () => {
    // A trim rebases the playhead onto a fresh 0-based clock and shifts
    // audioOffsetMs instead of re-encoding, so Home is the first kept second and
    // End is the last one — the offset is the player's business, not ours.
    const kept = 20_000;
    expect(seekTarget("replay.toStart", 5_000, kept)).toBe(0);
    expect(seekTarget("replay.toEnd", 5_000, kept)).toBe(kept);
    expect(seekTarget("replay.back10", 4_000, kept)).toBe(0);
  });
});

describe("seekTargetForKey", () => {
  it("reads the chords out of the command table", () => {
    expect(seekTargetForKey(stroke("ArrowLeft"), 30_000, DURATION, MAC)).toBe(25_000);
    expect(seekTargetForKey(stroke("ArrowRight"), 30_000, DURATION, MAC)).toBe(35_000);
    expect(seekTargetForKey(stroke("ArrowLeft", { shiftKey: true }), 30_000, DURATION, MAC)).toBe(
      20_000
    );
    expect(seekTargetForKey(stroke("ArrowRight", { shiftKey: true }), 30_000, DURATION, MAC)).toBe(
      40_000
    );
    expect(seekTargetForKey(stroke("Home"), 30_000, DURATION, MAC)).toBe(0);
    expect(seekTargetForKey(stroke("End"), 30_000, DURATION, MAC)).toBe(DURATION);
  });

  it("leaves ⌘← to the navigation command that owns it", () => {
    expect(seekTargetForKey(stroke("ArrowLeft", { metaKey: true }), 30_000, DURATION, MAC)).toBe(
      null
    );
    expect(seekTargetForKey(stroke("ArrowRight", { ctrlKey: true }), 30_000, DURATION, false)).toBe(
      null
    );
  });

  it("says nothing about a key that means nothing here", () => {
    expect(seekTargetForKey(stroke("k"), 30_000, DURATION, MAC)).toBe(null);
    expect(seekTargetForKey(stroke(" "), 30_000, DURATION, MAC)).toBe(null);
  });
});
