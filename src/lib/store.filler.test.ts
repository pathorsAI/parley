import { describe, it, expect, beforeEach, vi } from "vitest";

// The store's Tauri-less log path touches `window`; stub it (see store.actions.test).
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useLiveStore, useStore } from "./store";
import { seg } from "./test/fixtures";

// The live transcript (and its filler tally) is the live store's.
const INITIAL = useStore.getState();
const INITIAL_LIVE = useLiveStore.getState();
beforeEach(() => {
  useStore.setState(INITIAL, true);
  useLiveStore.setState(INITIAL_LIVE, true);
});

describe("live filler-sound counting (upsertSegment)", () => {
  it("counts filler sounds in the user's own segments", () => {
    useLiveStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um so uh yeah" }));
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
  });

  it("ignores the other party's segments", () => {
    useLiveStore.getState().upsertSegment(seg({ id: "b", source: "them", text: "um uh um" }));
    expect(useLiveStore.getState().filledPauseCount).toBe(0);
  });

  it("folds in only the delta as an interim segment grows", () => {
    const up = useLiveStore.getState().upsertSegment;
    up(seg({ id: "a", source: "me", isFinal: false, text: "um" })); // +1
    expect(useLiveStore.getState().filledPauseCount).toBe(1);
    up(seg({ id: "a", source: "me", isFinal: false, text: "um so uh" })); // +1 more
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
    up(seg({ id: "a", source: "me", isFinal: true, text: "um so uh, right" })); // no new filler
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
  });

  it("counts Mandarin hesitations the same as English", () => {
    useLiveStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "嗯我覺得呃這樣" }));
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
  });

  it("does not double-count across a rewrite that drops a filler", () => {
    const up = useLiveStore.getState().upsertSegment;
    up(seg({ id: "a", source: "me", isFinal: false, text: "um uh" })); // +2
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
    up(seg({ id: "a", source: "me", isFinal: true, text: "hello" })); // corrected → -2
    expect(useLiveStore.getState().filledPauseCount).toBe(0);
  });

  it("keeps counting while the main window views a replay, which it never touches", () => {
    useStore.setState({ appMode: "study", segments: [seg({ id: "r1", text: "replay" })] });
    useLiveStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um uh" }));
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
    expect(useStore.getState().filledPauseCount).toBe(0);
    expect(useStore.getState().segments.map((x) => x.id)).toEqual(["r1"]);
  });

  it("resets on a new meeting", () => {
    useLiveStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um uh" }));
    expect(useLiveStore.getState().filledPauseCount).toBe(2);
    useLiveStore.getState().startMeeting();
    expect(useLiveStore.getState().filledPauseCount).toBe(0);
    expect(useLiveStore.getState().filledPauseCounted).toEqual({});
  });
});
