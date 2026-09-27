import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The eligibility check reaches the sample loader's module graph (history → Tauri
// IPC, the logger). None of it runs here; mocking keeps native code out.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { DEFAULT_GETTING_STARTED } from "../store";
import type { GettingStartedState } from "../types";
import { LAP_CONFIRM_MS, createLapTimer, isLapEligible, lapPhase, type LapView } from "./lap";

const gs = (over: Partial<GettingStartedState> = {}): GettingStartedState => ({
  ...DEFAULT_GETTING_STARTED,
  recorded: true,
  ...over,
});

describe("lapPhase", () => {
  it("is the first of filed → replayed → handedOff not yet done", () => {
    expect(lapPhase(gs())).toBe("filed");
    expect(lapPhase(gs({ filed: true }))).toBe("replayed");
    expect(lapPhase(gs({ filed: true, replayed: true }))).toBe("handedOff");
    expect(lapPhase(gs({ filed: true, replayed: true, handedOff: true }))).toBe("done");
  });

  it("skips a step already done out of order", () => {
    expect(lapPhase(gs({ replayed: true }))).toBe("filed");
    expect(lapPhase(gs({ filed: true, handedOff: true }))).toBe("replayed");
  });
});

describe("isLapEligible", () => {
  const base = { gettingStarted: gs(), entryId: "rec-1", readOnly: false, libraryCount: 1 };

  it("shows on the user's only recording and on the sample", () => {
    expect(isLapEligible(base)).toBe(true);
    expect(isLapEligible({ ...base, libraryCount: 5 })).toBe(false);
    expect(isLapEligible({ ...base, entryId: "sample-hongsheng-en-v1", libraryCount: 5 })).toBe(true);
  });

  it("never shows on an org copy or without a saved entry", () => {
    expect(isLapEligible({ ...base, readOnly: true })).toBe(false);
    expect(isLapEligible({ ...base, entryId: null })).toBe(false);
  });

  it("follows the checklist: gone once dismissed or complete", () => {
    expect(isLapEligible({ ...base, gettingStarted: gs({ dismissedAt: 1 }) })).toBe(false);
    const all = gs({ filed: true, replayed: true, handedOff: true });
    expect(isLapEligible({ ...base, gettingStarted: all })).toBe(false);
  });
});

describe("createLapTimer (✓ then advance)", () => {
  let views: LapView[];
  beforeEach(() => {
    vi.useFakeTimers();
    views = [];
  });
  afterEach(() => vi.useRealTimers());

  it("starts on the derived step with nothing just completed", () => {
    const t = createLapTimer(gs({ filed: true }), (v) => views.push(v));
    expect(t.view()).toEqual({ phase: "replayed", justCompleted: null });
    expect(views).toEqual([]);
  });

  it("holds a ✓ for the finished step, then clears it after the hold", () => {
    const t = createLapTimer(gs(), (v) => views.push(v));
    t.update(gs({ filed: true }));
    expect(t.view()).toEqual({ phase: "replayed", justCompleted: "filed" });

    vi.advanceTimersByTime(LAP_CONFIRM_MS - 1);
    expect(t.view().justCompleted).toBe("filed");
    vi.advanceTimersByTime(1);
    expect(t.view()).toEqual({ phase: "replayed", justCompleted: null });
    expect(views).toEqual([
      { phase: "replayed", justCompleted: "filed" },
      { phase: "replayed", justCompleted: null },
    ]);
  });

  it("ignores updates that don't change the step", () => {
    const t = createLapTimer(gs(), (v) => views.push(v));
    t.update(gs({ replayed: true })); // out of order: still on "filed"
    expect(views).toEqual([]);
    expect(t.view()).toEqual({ phase: "filed", justCompleted: null });
  });

  it("names the step the bar was teaching when an earlier out-of-order step is skipped", () => {
    const t = createLapTimer(gs({ replayed: true }), (v) => views.push(v));
    t.update(gs({ replayed: true, filed: true }));
    expect(t.view()).toEqual({ phase: "handedOff", justCompleted: "filed" });
  });

  it("restarts the hold when another step lands during it", () => {
    const t = createLapTimer(gs(), (v) => views.push(v));
    t.update(gs({ filed: true }));
    vi.advanceTimersByTime(1000);
    t.update(gs({ filed: true, replayed: true }));
    expect(t.view()).toEqual({ phase: "handedOff", justCompleted: "replayed" });
    vi.advanceTimersByTime(1000);
    expect(t.view().justCompleted).toBe("replayed");
    vi.advanceTimersByTime(LAP_CONFIRM_MS - 1000);
    expect(t.view()).toEqual({ phase: "handedOff", justCompleted: null });
  });

  it("goes straight to the done card on the last step — it is its own ✓", () => {
    const t = createLapTimer(gs({ filed: true, replayed: true }), (v) => views.push(v));
    t.update(gs({ filed: true, replayed: true, handedOff: true }));
    expect(t.view()).toEqual({ phase: "done", justCompleted: null });
    vi.runAllTimers();
    expect(views).toEqual([{ phase: "done", justCompleted: null }]);
  });

  it("re-derives without a ✓ when the checklist is reset", () => {
    const t = createLapTimer(gs({ filed: true }), (v) => views.push(v));
    t.update(gs());
    expect(t.view()).toEqual({ phase: "filed", justCompleted: null });
  });

  it("stops its timer on dispose", () => {
    const t = createLapTimer(gs(), (v) => views.push(v));
    t.update(gs({ filed: true }));
    t.dispose();
    vi.runAllTimers();
    expect(views).toHaveLength(1);
  });
});
