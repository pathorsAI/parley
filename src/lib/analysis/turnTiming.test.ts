import { describe, it, expect } from "vitest";
import type { TranscriptSegment } from "../types";
import { countInterruptions, countLongPauses } from "./turnTiming";

let n = 0;
function seg(source: TranscriptSegment["source"], startMs: number, endMs: number, text = "話"): TranscriptSegment {
  n += 1;
  return { id: `s${n}`, source, speaker: 0, text, isFinal: true, startMs, endMs };
}

describe("countLongPauses", () => {
  it("counts a ≥3 s gap between the user's own consecutive segments", () => {
    const segs = [seg("them", 0, 1000), seg("me", 1500, 4000), seg("me", 7000, 9000), seg("me", 9500, 10_000)];
    expect(countLongPauses(segs)).toBe(1);
  });

  it("ignores gaps shorter than 3 s", () => {
    const segs = [seg("them", 0, 1000), seg("me", 1500, 4000), seg("me", 6900, 9000)];
    expect(countLongPauses(segs)).toBe(0);
  });

  it("does not count a silence the other side spoke in", () => {
    const segs = [seg("me", 0, 1000), seg("them", 2000, 3000), seg("me", 6000, 7000)];
    expect(countLongPauses(segs)).toBe(0);
  });

  it("does not count a gap a long 'them' segment still covers", () => {
    // Them started first and keeps talking through the user's silence.
    const segs = [seg("them", 0, 9000), seg("me", 500, 1000), seg("me", 8000, 8500)];
    expect(countLongPauses(segs)).toBe(0);
  });

  it("ignores interim and empty segments", () => {
    const interim = { ...seg("me", 2000, 2500), isFinal: false };
    const empty = seg("them", 2000, 2500, "  ");
    const segs = [seg("them", 0, 100), seg("me", 200, 1000), interim, empty, seg("me", 5000, 6000)];
    expect(countLongPauses(segs)).toBe(1);
  });

  it("is null when the session is not split by source", () => {
    expect(countLongPauses([seg("me", 0, 1000), seg("me", 5000, 6000)])).toBeNull();
    expect(countLongPauses([seg("mix", 0, 1000), seg("mix", 5000, 6000)])).toBeNull();
  });
});

describe("countInterruptions", () => {
  it("counts the user starting before the other side finished", () => {
    const segs = [seg("them", 0, 5000, "我想說的是"), seg("me", 4000, 6000)];
    expect(countInterruptions(segs)).toBe(1);
  });

  it("counts a start within 300 ms of an unfinished sentence", () => {
    const segs = [seg("them", 0, 5000, "所以我們這邊"), seg("me", 5200, 6000)];
    expect(countInterruptions(segs)).toBe(1);
  });

  it("does not count a quick reply to a finished sentence", () => {
    const segs = [seg("them", 0, 5000, "你覺得呢？"), seg("me", 5100, 6000)];
    expect(countInterruptions(segs)).toBe(0);
  });

  it("does not count a reply after a normal gap", () => {
    const segs = [seg("them", 0, 5000, "所以我們這邊"), seg("me", 5400, 6000)];
    expect(countInterruptions(segs)).toBe(0);
  });

  it("counts each of the other side's segments at most once", () => {
    const segs = [seg("them", 0, 10_000), seg("me", 2000, 2500), seg("me", 6000, 6500), seg("them", 11_000, 12_000), seg("me", 11_500, 13_000)];
    expect(countInterruptions(segs)).toBe(2);
  });

  it("does not count the user continuing their own turn", () => {
    const segs = [seg("them", 0, 1000, "好。"), seg("me", 2000, 3000), seg("me", 3100, 4000)];
    expect(countInterruptions(segs)).toBe(0);
  });

  it("is null when the session is not split by source", () => {
    expect(countInterruptions([seg("mix", 0, 1000), seg("mix", 500, 2000)])).toBeNull();
  });
});
