import { describe, it, expect } from "vitest";

import { cardPosition } from "./AnalysisTimeline";

/** A 12px dot (size-3) whose centre sits at `centreX`, on a 20px-tall lane. */
function dot(centreX: number, top = 300) {
  return { left: centreX - 6, right: centreX + 6, width: 12, top, bottom: top + 12 };
}

const VIEW = { width: 1000, height: 800 };
const CARD_W = 256;
const GAP = 8;

describe("cardPosition", () => {
  it("centres the card on the dot when there is room either side", () => {
    const { left } = cardPosition(dot(500), 120, false, VIEW);
    expect(left).toBe(500 - CARD_W / 2);
  });

  it("keeps the card inside the left edge instead of overflowing", () => {
    // The old absolutely-positioned tooltip escaped here and got clipped.
    const { left } = cardPosition(dot(10), 120, false, VIEW);
    expect(left).toBe(GAP);
  });

  it("keeps the card inside the right edge instead of overflowing", () => {
    const { left } = cardPosition(dot(995), 120, false, VIEW);
    expect(left).toBe(VIEW.width - CARD_W - GAP);
  });

  it("opens upward by default, clearing the dot", () => {
    const { top } = cardPosition(dot(500, 300), 120, false, VIEW);
    expect(top).toBe(300 - 120 - GAP);
  });

  it("flips below when there is no room above", () => {
    const d = dot(500, 20); // near the top of the window
    const { top } = cardPosition(d, 120, false, VIEW);
    expect(top).toBe(d.bottom + GAP);
  });

  it("honors preferBelow when the card fits below", () => {
    const d = dot(500, 300);
    const { top } = cardPosition(d, 120, true, VIEW);
    expect(top).toBe(d.bottom + GAP);
  });

  it("falls back above when preferBelow would run off the bottom", () => {
    const d = dot(500, 700); // bottom lane, tall card
    const { top } = cardPosition(d, 200, true, VIEW);
    expect(top).toBe(700 - 200 - GAP);
  });

  it("never positions the card off the top, even when it fits nowhere", () => {
    const { top } = cardPosition(dot(500, 40), 780, false, VIEW);
    expect(top).toBeGreaterThanOrEqual(GAP);
  });
});
