import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { runTimeline, typingSchedule } from "./timeline";
import { INTRO_BEATS, TRANSCRIPT_BUDGET_MS } from "./IntroStage";
import { sampleManifest } from "../../lib/onboarding/sample";

describe("intro beat schedule", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays record → transcript → folder → mcp → ready, at their offsets, in about seven seconds", () => {
    const fired: [string, number][] = [];
    const t0 = Date.now();
    runTimeline(INTRO_BEATS, (id) => fired.push([id, Date.now() - t0]));

    vi.advanceTimersByTime(0);
    expect(fired).toEqual([["record", 0]]);
    vi.advanceTimersByTime(899);
    expect(fired).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fired[fired.length - 1]).toEqual(["transcript", 900]);

    vi.runAllTimers();
    expect(fired.map(([id]) => id)).toEqual(["record", "transcript", "folder", "mcp", "ready"]);
    expect(fired[fired.length - 1][1]).toBeLessThanOrEqual(7000);
  });

  it("leaves the transcript beat enough room to finish typing before the folder beat", () => {
    const at = Object.fromEntries(INTRO_BEATS.map((b) => [b.id, b.at]));
    expect(at.folder - at.transcript).toBeGreaterThanOrEqual(TRANSCRIPT_BUDGET_MS);
  });

  it("stops when cancelled (Next pressed mid-sequence)", () => {
    const fired: string[] = [];
    const cancel = runTimeline(INTRO_BEATS, (id) => fired.push(id));
    vi.advanceTimersByTime(1000);
    cancel();
    vi.runAllTimers();
    expect(fired).toEqual(["record", "transcript"]);
  });
});

describe("typingSchedule", () => {
  it("types at 22 ms/char when the lines fit, one after another with a gap", () => {
    const s = typingSchedule([10, 20], 2800, 200, 22);
    expect(s.msPerChar).toBe(22);
    expect(s.starts).toEqual([0, 10 * 22 + 200]);
    expect(s.endMs).toBe(10 * 22 + 200 + 20 * 22);
  });

  it("speeds up rather than overrun the budget", () => {
    const s = typingSchedule([200, 200, 200], 2800, 220, 22);
    expect(s.msPerChar).toBeLessThan(22);
    expect(s.endMs).toBeLessThanOrEqual(2800 + 1e-6);
  });

  it("fits the sample's first three lines in both languages", () => {
    for (const lang of ["zh-TW", "en"] as const) {
      const lines = sampleManifest(lang).segments.slice(0, 3).map((x) => x.text.length);
      const s = typingSchedule(lines, TRANSCRIPT_BUDGET_MS, 220, 22);
      expect(s.endMs).toBeLessThanOrEqual(TRANSCRIPT_BUDGET_MS + 1e-6);
      expect(s.msPerChar).toBeLessThanOrEqual(22);
    }
  });
});
