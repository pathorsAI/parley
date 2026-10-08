import { describe, expect, it } from "vitest";
import {
  estimateMissingTiming,
  hasMissingTiming,
  withTimingRepaired,
  withoutEstimatedTiming,
} from "./timing";
import { estimateSpeechMs } from "./importTranscript";
import { seg } from "../test/fixtures";

/** What a phone batch transcription synced before #576 looks like: every line 0 → 0. */
function untimed(...texts: string[]) {
  return texts.map((text, i) => seg({ id: `mix-${i}`, source: "mix", speaker: i % 2, text, startMs: 0, endMs: 0 }));
}

describe("hasMissingTiming", () => {
  it("flags a transcript whose spoken lines all sit at 0 → 0", () => {
    expect(hasMissingTiming(untimed("你好", "嗨"))).toBe(true);
  });

  it("ignores blank lines when deciding", () => {
    const segments = [...untimed("你好", "嗨"), seg({ id: "x", text: "  ", startMs: 0, endMs: 0 })];
    expect(hasMissingTiming(segments)).toBe(true);
  });

  it("leaves a real transcript alone, even one that starts at 0:00", () => {
    const segments = [
      seg({ id: "a", text: "first", startMs: 0, endMs: 1200 }),
      seg({ id: "b", text: "second", startMs: 1300, endMs: 2000 }),
    ];
    expect(hasMissingTiming(segments)).toBe(false);
  });

  it("does not fire when any single line has timing", () => {
    const segments = [...untimed("a", "b"), seg({ id: "c", text: "c", startMs: 4000, endMs: 5000 })];
    expect(hasMissingTiming(segments)).toBe(false);
  });

  it("needs at least two spoken lines — one line at 0 is not evidence of anything", () => {
    expect(hasMissingTiming(untimed("only"))).toBe(false);
    expect(hasMissingTiming([])).toBe(false);
  });
});

describe("estimateMissingTiming", () => {
  it("lays the lines end to end over the recording, in proportion to how long each takes to say", () => {
    // 2 CJK chars → 540ms, 6 → 1620ms; the floor is 1000ms → weights 1000 / 1620.
    const segments = untimed("你好", "今天開會討論");
    const out = estimateMissingTiming(segments, 26_200);
    const w = [estimateSpeechMs("你好"), estimateSpeechMs("今天開會討論")];
    const scale = 26_200 / (w[0] + w[1]);
    expect(out.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, Math.round(w[0] * scale)],
      [Math.round(w[0] * scale), 26_200],
    ]);
    // Text, ids, speakers and order are untouched.
    expect(out.map((s) => s.id)).toEqual(["mix-0", "mix-1"]);
    expect(out.map((s) => s.text)).toEqual(["你好", "今天開會討論"]);
  });

  it("spreads lines across the whole recording so later lines get later times", () => {
    const out = estimateMissingTiming(untimed("one two three", "four five", "six seven eight nine"), 60_000);
    const starts = out.map((s) => s.startMs);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(starts[0]);
    expect(starts[2]).toBeGreaterThan(starts[1]);
    expect(out[2].endMs).toBe(60_000);
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBe(out[i - 1].endMs);
  });

  it("falls back to the raw per-line estimates when the duration is unknown", () => {
    const out = estimateMissingTiming(untimed("你好", "嗨"), 0);
    expect(out.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [1000, 2000],
    ]);
  });

  it("gives a blank line a zero-length slot where it falls", () => {
    const segments = [...untimed("你好"), seg({ id: "blank", text: " ", startMs: 0, endMs: 0 }), ...untimed("嗨")];
    const out = estimateMissingTiming(segments, 4000);
    expect(out[1].startMs).toBe(out[1].endMs);
    expect(out[1].startMs).toBe(2000);
  });

  // The Rust MCP server (mcp.rs `estimated_starts`) must agree to the
  // millisecond, or a finding an external analyst anchors at [m:ss] lands on a
  // different line here. The Rust test pins these same numbers.
  it("matches the cross-language fixture", () => {
    const segments = untimed("你好，今天我們討論報價。", "OK, let's go over the price.", "好", "Sounds good 那就這樣");
    const out = estimateMissingTiming(segments, 95_000);
    expect(out.map((s) => s.startMs)).toEqual([0, 32_801, 60_499, 72_647]);
  });
});

describe("withTimingRepaired / withoutEstimatedTiming", () => {
  it("returns a timed transcript as the same array", () => {
    const segments = [seg({ id: "a", startMs: 0, endMs: 900 }), seg({ id: "b", startMs: 1000, endMs: 2000 })];
    const out = withTimingRepaired(segments, 2000);
    expect(out.estimated).toBe(false);
    expect(out.segments).toBe(segments);
  });

  it("estimates an untimed one and says so", () => {
    const out = withTimingRepaired(untimed("你好", "嗨"), 10_000);
    expect(out.estimated).toBe(true);
    expect(out.segments[1].startMs).toBe(5000);
  });

  it("round-trips: stripping the estimate gives back the untimed transcript, which re-estimates the same", () => {
    const original = untimed("你好", "今天開會討論", "好的");
    const { segments } = withTimingRepaired(original, 30_000);
    const stripped = withoutEstimatedTiming(segments);
    expect(stripped).toEqual(original);
    expect(withTimingRepaired(stripped, 30_000).segments).toEqual(segments);
  });
});
