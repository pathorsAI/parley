import { describe, expect, it } from "vitest";
import { FLOATING_SIZE, MINI_WIDTH, floatingFrame, nearDock } from "./floatingWindow";

describe("floatingFrame", () => {
  it("keeps the frame's size on a roomy screen, against the right edge", () => {
    const f = floatingFrame({ width: 1728, height: 1080 });
    expect(f.width).toBe(FLOATING_SIZE.width);
    expect(f.height).toBe(FLOATING_SIZE.height);
    expect(f.x).toBe(1728 - FLOATING_SIZE.width - 24);
    expect(f.y).toBe(Math.round((1080 - FLOATING_SIZE.height) / 2));
  });

  it("shrinks to fit a short screen and offsets by the screen's origin", () => {
    const f = floatingFrame({ width: 1280, height: 720 }, { x: 1728, y: 25 });
    expect(f.height).toBe(720 - 72);
    expect(f.x).toBe(1728 + 1280 - FLOATING_SIZE.width - 24);
    expect(f.y).toBe(25 + Math.round((720 - f.height) / 2));
  });

  it("never goes below its minimum size", () => {
    const f = floatingFrame({ width: 300, height: 300 });
    expect(f.width).toBe(420);
    expect(f.height).toBe(480);
    expect(f.x).toBe(0);
  });
});

describe("nearDock", () => {
  // A 1512-wide work area starting under a 38px menu bar.
  const area = { x: 0, y: 38, width: 1512 };
  const centered = (1512 - MINI_WIDTH) / 2;

  it("docks a mini window let go near the middle of the top edge", () => {
    expect(nearDock({ x: centered + 100, y: 60, width: MINI_WIDTH }, area)).toBe(true);
  });

  it("leaves one let go at a top corner", () => {
    expect(nearDock({ x: 20, y: 40, width: MINI_WIDTH }, area)).toBe(false);
  });

  it("leaves one let go in the middle of the screen", () => {
    expect(nearDock({ x: centered, y: 400, width: MINI_WIDTH }, area)).toBe(false);
  });

  it("measures from the work area of a second screen", () => {
    const right = { x: 1512, y: 0, width: 1920 };
    expect(nearDock({ x: 1512 + (1920 - MINI_WIDTH) / 2, y: 10, width: MINI_WIDTH }, right)).toBe(true);
    expect(nearDock({ x: centered, y: 10, width: MINI_WIDTH }, right)).toBe(false);
  });
});
