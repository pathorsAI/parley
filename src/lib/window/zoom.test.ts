import { describe, expect, it } from "vitest";
import { FLOATING_SIZE, MAIN_DEFAULT, maxFullWidth } from "../meeting/floatingWindow";
import { clampToArea } from "./frame";
import { FILL_SLACK, isFilling, mainZoomFallback, meetingZoomFallback, restoreFrame } from "./zoom";

/** A 1728 x 1117 MacBook screen, below a 33 px menu bar. */
const area = { x: 0, y: 33, width: 1728, height: 1084 };

describe("isFilling", () => {
  it("is true for a frame exactly on the work area", () => {
    expect(isFilling({ ...area }, area)).toBe(true);
  });

  it("is true for a tiled window with margins", () => {
    expect(isFilling({ x: 8, y: 41, width: 1712, height: 1068 }, area)).toBe(true);
  });

  it("is true for a frame that spills past the work area (fullscreen-sized)", () => {
    expect(isFilling({ x: 0, y: 0, width: 1728, height: 1117 }, area)).toBe(true);
  });

  it("is false for a window short of any edge by more than the slack", () => {
    expect(isFilling({ x: 0, y: 33, width: 1728 - FILL_SLACK - 1, height: 1084 }, area)).toBe(false);
    expect(isFilling({ x: FILL_SLACK + 1, y: 33, width: 1728, height: 1084 }, area)).toBe(false);
    expect(isFilling({ x: 0, y: 33, width: 1728, height: 1084 - FILL_SLACK - 1 }, area)).toBe(false);
  });

  it("is false for a normal window", () => {
    expect(isFilling({ x: 200, y: 120, width: 1200, height: 800 }, area)).toBe(false);
  });

  it("takes the screen's origin into account (a second monitor)", () => {
    const right = { x: 1728, y: 0, width: 2560, height: 1415 };
    expect(isFilling({ ...right }, right)).toBe(true);
    expect(isFilling({ ...area }, right)).toBe(false);
  });
});

describe("restoreFrame", () => {
  it("goes back exactly where it was when that fits", () => {
    const was = { x: 120, y: 90, width: 1200, height: 800 };
    expect(restoreFrame(was, area)).toEqual(was);
  });

  it("keeps a frame wider than a third of the screen (no meeting-window cap)", () => {
    const was = { x: 100, y: 100, width: 1400, height: 900 };
    expect(restoreFrame(was, area).width).toBe(1400);
  });

  it("moves a frame that hangs off the edge back on screen", () => {
    const was = { x: 1000, y: 33, width: 1200, height: 800 };
    const back = restoreFrame(was, area);
    expect(back.x + back.width).toBe(1728 - 8);
    expect(back.width).toBe(1200);
  });

  it("shrinks a frame larger than the screen it comes back on", () => {
    const back = restoreFrame({ x: 10, y: 40, width: 2400, height: 1400 }, area);
    expect(back).toEqual({ x: 8, y: 41, width: 1712, height: 1068 });
  });

  it("centres a frame remembered on another screen", () => {
    const back = restoreFrame({ x: 2500, y: 200, width: 1000, height: 700 }, area);
    expect(back).toEqual({ x: 364, y: Math.round(33 + (1084 - 700) / 2), width: 1000, height: 700 });
  });
});

describe("zoom fallbacks", () => {
  it("main window: its default size, centred", () => {
    expect(mainZoomFallback(area)).toEqual({
      x: (1728 - MAIN_DEFAULT.width) / 2,
      y: 33 + (1084 - MAIN_DEFAULT.height) / 2,
      width: MAIN_DEFAULT.width,
      height: MAIN_DEFAULT.height,
    });
  });

  it("main window: fitted to a small screen", () => {
    const small = { x: 0, y: 25, width: 1024, height: 700 };
    expect(mainZoomFallback(small)).toEqual({ x: 8, y: 33, width: 1008, height: 684 });
  });

  it("meeting window: a third of the screen at most, against the right edge", () => {
    const f = meetingZoomFallback(area);
    expect(f.width).toBe(Math.min(FLOATING_SIZE.width, maxFullWidth(area.width)));
    expect(f.x + f.width).toBe(1728 - 24);
    expect(f.y).toBeGreaterThanOrEqual(area.y);
    expect(f.y + f.height).toBeLessThanOrEqual(area.y + area.height);
  });
});

describe("clampToArea", () => {
  it("caps the width when asked", () => {
    expect(clampToArea({ x: 0, y: 33, width: 1200, height: 800 }, area, 8, 576).width).toBe(576);
  });
});
