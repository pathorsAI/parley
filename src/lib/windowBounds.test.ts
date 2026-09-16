import { describe, expect, it } from "vitest";
import { clampWindowSize, type WorkArea } from "./windowBounds";

// The three real requests, so the numbers below are the ones that actually ship.
const SETTINGS = { width: 880, height: 760, minWidth: 720, minHeight: 520 };
const DIAGNOSTICS = { width: 900, height: 600, minWidth: 600, minHeight: 380 };
const FINDING_SOLUTION = { width: 420, height: 640, minWidth: 320, minHeight: 360 };

/** A monitor work area in PHYSICAL px, the way Tauri reports it. */
function area(width: number, height: number, scaleFactor: number): WorkArea {
  return { size: { width, height }, scaleFactor };
}

describe("a window is clamped to the logical space the display actually has", () => {
  it("shrinks Settings to fit a 1920x1080 panel at 150% scaling", () => {
    // 1920x1080 at 150% is 1280x720 logical, and the taskbar leaves about 1040
    // physical px of work area — 693 logical. Settings asks for 760.
    const clamped = clampWindowSize(SETTINGS, area(1920, 1040, 1.5));

    expect(clamped.height).toBe(645); // floor(1040 / 1.5) minus the frame allowance
    expect(clamped.width).toBe(880); // 1272 logical px of width to spare
  });

  it("divides physical pixels by the scale factor rather than multiplying", () => {
    // The whole bug in one assertion: multiply and this 150% display looks like
    // it has 2880x1560 logical px of room, so Settings' 760 would pass through
    // untouched. Divide and it only has 693, so it has to give.
    const clamped = clampWindowSize(SETTINGS, area(1920, 1040, 1.5));

    expect(clamped.height).toBeLessThan(SETTINGS.height);
    // Diagnostics' 600 does fit in the same 693 — the clamp is a ceiling, not a
    // blanket shrink.
    expect(clampWindowSize(DIAGNOSTICS, area(1920, 1040, 1.5))).toEqual(DIAGNOSTICS);
  });

  it("leaves a window that already fits exactly as it was asked for", () => {
    // A 14" MacBook Pro: 3024x1964 at 2x, so 1512x945 logical once the menu bar
    // is out. Every one of these windows was sized for a machine like this.
    expect(clampWindowSize(SETTINGS, area(3024, 1890, 2))).toEqual(SETTINGS);
    expect(clampWindowSize(DIAGNOSTICS, area(3024, 1890, 2))).toEqual(DIAGNOSTICS);
    expect(clampWindowSize(FINDING_SOLUTION, area(3024, 1890, 2))).toEqual(FINDING_SOLUTION);
  });
});

describe("a minimum size larger than the screen is unsatisfiable, so it is clamped too", () => {
  it("pulls Settings' 520px minimum height down to what the display allows", () => {
    // This minimum is what traps the window today: the bottom edge is off
    // screen and the minimum stops you dragging it back.
    const clamped = clampWindowSize(SETTINGS, area(1280, 680, 1.5));

    expect(clamped.height).toBe(405);
    expect(clamped.minHeight).toBe(405);
    expect(clamped.minHeight).toBeLessThanOrEqual(clamped.height);
  });

  it("never reports a minimum bigger than the size it just clamped to", () => {
    const clamped = clampWindowSize(FINDING_SOLUTION, area(640, 480, 2));

    expect(clamped.minWidth).toBe(clamped.width);
    expect(clamped.minHeight).toBe(clamped.height);
  });

  it("leaves the minimums absent when the caller never asked for any", () => {
    const clamped = clampWindowSize({ width: 880, height: 760 }, area(1280, 680, 1.5));

    expect(clamped).toEqual({ width: 845, height: 405 });
  });
});

describe("an unmeasurable display clamps nothing rather than guessing", () => {
  it("passes the request straight through when there is no monitor", () => {
    expect(clampWindowSize(SETTINGS, null)).toEqual(SETTINGS);
  });

  it("treats a missing scale factor as 1x instead of dividing the screen away", () => {
    expect(clampWindowSize(SETTINGS, area(1920, 1040, 0))).toEqual({
      width: 880,
      height: 760,
      minWidth: 720,
      minHeight: 520,
    });
  });

  it("keeps a positive size even on an absurdly small work area", () => {
    const clamped = clampWindowSize(SETTINGS, area(10, 10, 4));

    expect(clamped.width).toBeGreaterThan(0);
    expect(clamped.height).toBeGreaterThan(0);
  });
});
