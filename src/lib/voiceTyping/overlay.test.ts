import { describe, expect, it } from "vitest";
import { bottomCenterPhysical, type MonitorGeometry } from "./overlay";

// Mirrors the module's own constants (the overlay is 460x180 logical px and
// clears the Dock by 64).
const WIDTH = 460;
const HEIGHT = 180;
const BOTTOM_MARGIN = 64;

function monitor(over: Partial<MonitorGeometry> = {}): MonitorGeometry {
  return {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
    ...over,
  };
}

describe("bottomCenterPhysical", () => {
  it("centres horizontally and clears the bottom by the margin (1x)", () => {
    const { x, y } = bottomCenterPhysical(monitor());
    expect(x).toBe((1920 - WIDTH) / 2);
    expect(y).toBe(1080 - HEIGHT - BOTTOM_MARGIN);
  });

  it("scales the overlay's logical size on a Retina display", () => {
    // 2x display: 3024x1964 physical = 1512x982 logical.
    const { x, y } = bottomCenterPhysical(
      monitor({ size: { width: 3024, height: 1964 }, scaleFactor: 2 }),
    );
    expect(x).toBe((3024 - WIDTH * 2) / 2);
    expect(y).toBe(1964 - (HEIGHT + BOTTOM_MARGIN) * 2);
  });

  it("offsets by the monitor's origin, including displays left of primary", () => {
    const { x, y } = bottomCenterPhysical(
      monitor({ position: { x: -2560, y: -200 }, size: { width: 2560, height: 1440 } }),
    );
    expect(x).toBe(-2560 + (2560 - WIDTH) / 2);
    expect(y).toBe(-200 + 1440 - HEIGHT - BOTTOM_MARGIN);
  });

  it("stays inside a small external display", () => {
    const mon = monitor({ position: { x: 1920, y: 0 }, size: { width: 1280, height: 720 } });
    const { x, y } = bottomCenterPhysical(mon);
    expect(x).toBeGreaterThanOrEqual(mon.position.x);
    expect(x + WIDTH).toBeLessThanOrEqual(mon.position.x + mon.size.width);
    expect(y).toBeGreaterThanOrEqual(mon.position.y);
    expect(y + HEIGHT).toBeLessThanOrEqual(mon.position.y + mon.size.height);
  });

  it("treats a missing scale factor as 1x rather than collapsing to the corner", () => {
    const { x, y } = bottomCenterPhysical(monitor({ scaleFactor: 0 }));
    expect(x).toBe((1920 - WIDTH) / 2);
    expect(y).toBe(1080 - HEIGHT - BOTTOM_MARGIN);
  });

  it("returns integer physical pixels", () => {
    const { x, y } = bottomCenterPhysical(
      monitor({ size: { width: 1707, height: 1067 }, scaleFactor: 1.5 }),
    );
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
  });
});
