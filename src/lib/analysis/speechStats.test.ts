import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { clock, computeSpeechStats, speechUnits } from "./speechStats";

let n = 0;
function seg(source: TranscriptSegment["source"], startS: number, endS: number, text: string): TranscriptSegment {
  n += 1;
  return { id: `s${n}`, source, speaker: 0, text, isFinal: true, startMs: startS * 1000, endMs: endS * 1000 };
}

describe("speechUnits", () => {
  it("counts CJK characters and Latin words", () => {
    expect(speechUnits("我們下週 launch 新版本")).toBe(8);
    expect(speechUnits("Hello, world!")).toBe(2);
    expect(speechUnits("，。")).toBe(0);
  });
});

describe("computeSpeechStats", () => {
  it("reads pace from the user's own talk", () => {
    // 30 characters over 15 s, twice → 120 字/分.
    const text = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
    const stats = computeSpeechStats([seg("me", 0, 15, text), seg("me", 20, 35, text)]);
    expect(stats.textPace).toBe(120);
    expect(stats.paceTimeline).toEqual([{ atMs: 0, perMin: 120 }]);
  });

  it("counts a silence between the user's segments as a pause, not one the other side filled", () => {
    const stats = computeSpeechStats([
      seg("me", 0, 5, "我先講"),
      seg("me", 7, 10, "然後"),
      seg("them", 11, 14, "好的我了解"),
      seg("me", 15, 20, "接著"),
      seg("me", 80, 85, "很久以後"),
    ]);
    expect(stats.pauses).toEqual([{ atMs: 5000, ms: 2000 }]);
  });

  it("tallies fillers and finds immediate repetitions", () => {
    const stats = computeSpeechStats([seg("me", 0, 10, "嗯我覺得我覺得然後就是這樣 the the plan")]);
    expect(stats.fillerTotal).toBeGreaterThan(0);
    expect(stats.fillers.some((f) => f.word === "然後")).toBe(true);
    expect(stats.repetitions.map((r) => r.text)).toEqual(["我覺得我覺得", "the the"]);
  });

  it("leaves reduplicated words alone", () => {
    expect(computeSpeechStats([seg("me", 0, 5, "謝謝大家看看")]).repetitions).toEqual([]);
  });

});

describe("clock", () => {
  it("formats a position", () => {
    expect(clock(65_000)).toBe("1:05");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
});
