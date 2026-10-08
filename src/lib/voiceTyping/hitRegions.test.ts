import { describe, expect, it } from "vitest";
import { HIT_PAD_PX, hitAt, sameHitRects, toHitRects, type HitBox } from "./hitRegions";

// The overlay window at page zoom 1: 460×180 CSS px.
const VIEWPORT = { width: 460, height: 180 };
// The waveform pill, bottom-centre (126×36, 16 px above the bottom edge).
const PILL: HitBox = { left: 167, top: 128, width: 126, height: 36 };
// A transcript bubble above it.
const BUBBLE: HitBox = { left: 40, top: 40, width: 380, height: 80 };

describe("toHitRects", () => {
  it("turns CSS boxes into viewport fractions with the origin at the top-left", () => {
    expect(toHitRects([PILL], VIEWPORT, 0)).toEqual([
      { x: 0.363, y: 0.7111, w: 0.274, h: 0.2 },
    ]);
  });

  it("gives the same fractions at any page zoom", () => {
    // At 120 % the same layout measures 1/1.2 as many CSS px in a viewport
    // that is 1/1.2 as wide — the ratio is what survives.
    const zoom = 1.2;
    const scaled = (b: HitBox): HitBox => ({
      left: b.left / zoom,
      top: b.top / zoom,
      width: b.width / zoom,
      height: b.height / zoom,
    });
    const atOne = toHitRects([PILL, BUBBLE], VIEWPORT, 0);
    const zoomed = toHitRects(
      [scaled(PILL), scaled(BUBBLE)],
      { width: VIEWPORT.width / zoom, height: VIEWPORT.height / zoom },
      0,
    );
    expect(sameHitRects(atOne, zoomed)).toBe(true);
  });

  it("pads every block, and clamps the padding to the viewport", () => {
    const [pill] = toHitRects([PILL], VIEWPORT);
    expect(pill.x).toBeCloseTo((PILL.left - HIT_PAD_PX) / 460, 3);
    expect(pill.y).toBeCloseTo((PILL.top - HIT_PAD_PX) / 180, 3);
    expect(pill.w).toBeCloseTo((PILL.width + 2 * HIT_PAD_PX) / 460, 3);
    expect(pill.h).toBeCloseTo((PILL.height + 2 * HIT_PAD_PX) / 180, 3);

    // A block flush with the corner cannot pad past it.
    const [corner] = toHitRects([{ left: 0, top: 0, width: 460, height: 180 }], VIEWPORT);
    expect(corner).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("drops blocks with no area and blocks entirely off the viewport", () => {
    const rects = toHitRects(
      [
        { left: 100, top: 100, width: 0, height: 20 }, // not laid out
        { left: 100, top: 100, width: 20, height: 0 },
        { left: 600, top: 40, width: 50, height: 20 }, // past the right edge
        { left: Number.NaN, top: 0, width: 10, height: 10 },
        PILL,
      ],
      VIEWPORT,
      0,
    );
    expect(rects).toHaveLength(1);
    expect(hitAt(rects, 0.5, 0.8)).toBe(true);
  });

  it("reports nothing for nothing — what the overlay sends while it fades out", () => {
    expect(toHitRects([], VIEWPORT)).toEqual([]);
  });

  it("reports nothing for a viewport with no size", () => {
    expect(toHitRects([PILL], { width: 0, height: 180 })).toEqual([]);
  });
});

describe("sameHitRects", () => {
  it("ignores float noise from a sub-pixel re-layout", () => {
    const a = toHitRects([PILL], VIEWPORT);
    const b = a.map((r) => ({ ...r, x: r.x + 0.00004, h: r.h - 0.00004 }));
    expect(sameHitRects(a, b)).toBe(true);
  });

  it("notices a transcript bubble that grew a line", () => {
    const before = toHitRects([BUBBLE, PILL], VIEWPORT);
    const grown = toHitRects(
      [{ ...BUBBLE, top: BUBBLE.top - 19, height: BUBBLE.height + 19 }, PILL],
      VIEWPORT,
    );
    expect(sameHitRects(before, grown)).toBe(false);
  });

  it("notices a block appearing or going away", () => {
    const pillOnly = toHitRects([PILL], VIEWPORT);
    const withBubble = toHitRects([BUBBLE, PILL], VIEWPORT);
    expect(sameHitRects(pillOnly, withBubble)).toBe(false);
    expect(sameHitRects(withBubble, pillOnly)).toBe(false);
    expect(sameHitRects([], [])).toBe(true);
  });
});

describe("hitAt", () => {
  const rects = [{ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }];

  it("hits inside a block and misses beside it", () => {
    expect(hitAt(rects, 0.5, 0.6)).toBe(true);
    expect(hitAt(rects, 0.1, 0.6)).toBe(false);
    expect(hitAt(rects, 0.5, 0.2)).toBe(false);
  });

  it("counts the left and top edges in, the right and bottom edges out", () => {
    expect(hitAt(rects, 0.25, 0.5)).toBe(true);
    expect(hitAt(rects, 0.75, 0.6)).toBe(false);
    expect(hitAt(rects, 0.5, 0.75)).toBe(false);
  });

  it("never hits with no blocks reported", () => {
    expect(hitAt([], 0.5, 0.5)).toBe(false);
  });

  it("never hits a point off the viewport or not a number", () => {
    const whole = [{ x: 0, y: 0, w: 1, h: 1 }];
    expect(hitAt(whole, 0, 0)).toBe(true);
    for (const [fx, fy] of [
      [-0.01, 0.5],
      [0.5, -0.01],
      [1, 0.5],
      [0.5, 1],
      [Number.NaN, 0.5],
      [0.5, Number.POSITIVE_INFINITY],
    ]) {
      expect(hitAt(whole, fx, fy)).toBe(false);
    }
  });
});
