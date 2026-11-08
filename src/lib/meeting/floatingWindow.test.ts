import { describe, expect, it } from "vitest";
import { FLOATING_SIZE, MINI_WIDTH, dockPosition, dockTarget, fitToArea, floatingFrame } from "./floatingWindow";

describe("floatingFrame", () => {
  it("keeps the frame's size on a very wide screen, against the right edge", () => {
    const f = floatingFrame({ width: 2560, height: 1080 });
    expect(f.width).toBe(FLOATING_SIZE.width);
    expect(f.height).toBe(FLOATING_SIZE.height);
    expect(f.x).toBe(2560 - FLOATING_SIZE.width - 24);
    expect(f.y).toBe(Math.round((1080 - FLOATING_SIZE.height) / 2));
  });

  it("shrinks to fit a short screen and offsets by the screen's origin", () => {
    const f = floatingFrame({ width: 1280, height: 720 }, { x: 1728, y: 25 });
    expect(f.height).toBe(720 - 72);
    expect(f.width).toBe(426);
    expect(f.x).toBe(1728 + 1280 - 426 - 24);
    expect(f.y).toBe(25 + Math.round((720 - f.height) / 2));
  });

  it("is never wider than a third of the screen", () => {
    expect(floatingFrame({ width: 1728, height: 1080 }).width).toBe(576);
  });

  it("never goes below its minimum size", () => {
    const f = floatingFrame({ width: 300, height: 300 });
    expect(f.width).toBe(360);
    expect(f.height).toBe(480);
    expect(f.x).toBe(0);
  });
});

describe("dockTarget", () => {
  // A 1512-wide work area starting under a 38px menu bar.
  const area = { x: 0, y: 38, width: 1512 };
  const centered = (1512 - MINI_WIDTH) / 2;

  it("pulls a mini window near the top edge's middle under the notch", () => {
    expect(dockTarget({ x: centered + 100, y: 60, width: MINI_WIDTH }, area)).toBe("notch");
  });

  it("pulls one near the top-left to the left corner", () => {
    expect(dockTarget({ x: 20, y: 40, width: MINI_WIDTH }, area)).toBe("left");
  });

  it("pulls one just left of the middle under the notch", () => {
    expect(dockTarget({ x: centered - 150, y: 40, width: MINI_WIDTH }, area)).toBe("notch");
  });

  it("pulls one near the top-right to the corner", () => {
    expect(dockTarget({ x: 1512 - MINI_WIDTH - 10, y: 90, width: MINI_WIDTH }, area)).toBe("corner");
  });

  it("leaves one further down the screen", () => {
    expect(dockTarget({ x: centered, y: 400, width: MINI_WIDTH }, area)).toBeNull();
    expect(dockTarget({ x: centered, y: 38 + 73, width: MINI_WIDTH }, area)).toBeNull();
  });

  it("only docks to the screen the window's middle is on", () => {
    const right = { x: 1512, y: 0, width: 1920 };
    expect(dockTarget({ x: 1512 + (1920 - MINI_WIDTH) / 2, y: 10, width: MINI_WIDTH }, right)).toBe("notch");
    expect(dockTarget({ x: centered, y: 10, width: MINI_WIDTH }, right)).toBeNull();
  });
});

describe("dockPosition", () => {
  const area = { x: 1512, y: 25, width: 1920 };

  it("centers the notch spot under the menu bar", () => {
    expect(dockPosition("notch", area, 440)).toEqual({ x: 1512 + 740, y: 33 });
  });

  it("keeps the left corner spot off the left edge", () => {
    expect(dockPosition("left", area, 440)).toEqual({ x: 1512 + 8, y: 33 });
  });

  it("keeps the corner spot off the right edge", () => {
    expect(dockPosition("corner", area, 440)).toEqual({ x: 1512 + 1920 - 440 - 8, y: 33 });
  });
});

describe("fitToArea", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  it("leaves a frame that already fits alone", () => {
    expect(fitToArea({ x: 100, y: 100, width: 460, height: 600 }, area)).toEqual({ x: 100, y: 100, width: 460, height: 600 });
  });
  it("moves a frame that would run off the right and bottom edges back on screen", () => {
    expect(fitToArea({ x: 1200, y: 500, width: 460, height: 600 }, area)).toEqual({ x: 972, y: 292, width: 460, height: 600 });
  });
  it("narrows a frame wider than a third of the screen", () => {
    expect(fitToArea({ x: 992, y: 100, width: 760, height: 600 }, area)).toEqual({ x: 952, y: 100, width: 480, height: 600 });
  });
  it("shrinks a frame taller than the screen to fit", () => {
    expect(fitToArea({ x: 992, y: 10, width: 460, height: 900 }, area)).toEqual({ x: 972, y: 33, width: 460, height: 859 });
  });
});
