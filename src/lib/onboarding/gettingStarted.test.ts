import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useStore } from "../store";
import type { GettingStartedState } from "../types";
import {
  GETTING_STARTED_STEPS,
  dismissGettingStarted,
  gettingStartedProgress,
  hasSeenHint,
  isGettingStartedVisible,
  markGettingStarted,
  markHintSeen,
  resetGettingStarted,
} from "./gettingStarted";
import { isSampleEntry, loadSampleRecording } from "./sample";

const INITIAL = useStore.getState();
beforeEach(() => useStore.setState(INITIAL, true));
afterEach(() => vi.useRealTimers());

const gs = () => useStore.getState().settings.gettingStarted;

function state(patch: Partial<GettingStartedState> = {}): GettingStartedState {
  return { recorded: false, filed: false, replayed: false, handedOff: false, dismissedAt: null, ...patch };
}

describe("getting-started defaults", () => {
  it("a fresh store starts with nothing done and nothing seen", () => {
    expect(gs()).toEqual(state());
    expect(useStore.getState().settings.hintsSeen).toEqual([]);
  });

  it("lists the four steps in display order", () => {
    expect(GETTING_STARTED_STEPS).toEqual(["recorded", "filed", "replayed", "handedOff"]);
  });
});

describe("markGettingStarted", () => {
  it("flips only the given step", () => {
    markGettingStarted("filed");
    expect(gs()).toEqual(state({ filed: true }));
  });

  it("is idempotent and does not write the store when already done", () => {
    markGettingStarted("recorded");
    const after = useStore.getState().settings;
    const spy = vi.spyOn(useStore.getState(), "updateSettings");
    markGettingStarted("recorded");
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().settings).toBe(after);
    expect(gs()).toEqual(state({ recorded: true }));
  });

  it("keeps a dismissal intact", () => {
    useStore.getState().updateSettings({ gettingStarted: state({ dismissedAt: 123 }) });
    markGettingStarted("replayed");
    expect(gs()).toEqual(state({ replayed: true, dismissedAt: 123 }));
  });

  it("leaves other settings alone", () => {
    const before = useStore.getState().settings;
    markGettingStarted("handedOff");
    const { gettingStarted: _a, ...restAfter } = useStore.getState().settings;
    const { gettingStarted: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
  });
});

describe("dismiss / reset", () => {
  it("dismiss stamps the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    markGettingStarted("recorded");
    dismissGettingStarted();
    expect(gs()).toEqual(state({ recorded: true, dismissedAt: Date.parse("2026-09-26T00:00:00Z") }));
  });

  it("reset clears every flag and the dismissal", () => {
    for (const step of GETTING_STARTED_STEPS) markGettingStarted(step);
    dismissGettingStarted();
    resetGettingStarted();
    expect(gs()).toEqual(state());
    expect(isGettingStartedVisible(gs())).toBe(true);
  });
});

describe("gettingStartedProgress", () => {
  it("counts done steps out of four", () => {
    expect(gettingStartedProgress(state())).toEqual({ done: 0, total: 4 });
    expect(gettingStartedProgress(state({ recorded: true, replayed: true }))).toEqual({ done: 2, total: 4 });
    expect(
      gettingStartedProgress(state({ recorded: true, filed: true, replayed: true, handedOff: true })),
    ).toEqual({ done: 4, total: 4 });
  });

  it("ignores the dismissal", () => {
    expect(gettingStartedProgress(state({ filed: true, dismissedAt: 1 }))).toEqual({ done: 1, total: 4 });
  });
});

describe("isGettingStartedVisible", () => {
  it("is visible while unfinished and not dismissed", () => {
    expect(isGettingStartedVisible(state())).toBe(true);
    expect(isGettingStartedVisible(state({ recorded: true, filed: true, replayed: true }))).toBe(true);
  });

  it("hides once dismissed", () => {
    expect(isGettingStartedVisible(state({ dismissedAt: 0 }))).toBe(false);
    expect(isGettingStartedVisible(state({ dismissedAt: Date.now() }))).toBe(false);
  });

  it("hides once all four are done", () => {
    expect(
      isGettingStartedVisible(state({ recorded: true, filed: true, replayed: true, handedOff: true })),
    ).toBe(false);
  });
});

describe("hints", () => {
  it("are unseen by default", () => {
    expect(hasSeenHint(useStore.getState().settings, "replay.seek")).toBe(false);
  });

  it("markHintSeen records the hint without touching others", () => {
    markHintSeen("replay.seek");
    const s = useStore.getState().settings;
    expect(hasSeenHint(s, "replay.seek")).toBe(true);
    expect(hasSeenHint(s, "report.filing")).toBe(false);
  });

  it("markHintSeen is idempotent", () => {
    markHintSeen("copy.handoff");
    markHintSeen("copy.handoff");
    markHintSeen("speakers.whoAmI");
    expect(useStore.getState().settings.hintsSeen).toEqual(["copy.handoff", "speakers.whoAmI"]);
  });
});

describe("sample stub", () => {
  it("loads nothing yet", async () => {
    await expect(loadSampleRecording()).resolves.toBeNull();
  });

  it("recognises sample ids by prefix", () => {
    expect(isSampleEntry({ id: "sample-intro" })).toBe(true);
    expect(isSampleEntry({ id: "abc-sample-" })).toBe(false);
  });
});
