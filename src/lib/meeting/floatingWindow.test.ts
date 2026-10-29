import { describe, expect, it } from "vitest";
import { FLOATING_SIZE, floatingFrame } from "./floatingWindow";

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
