import { describe, it, expect, beforeEach, vi } from "vitest";

// The store's Tauri-less log path touches `window`; stub it (see store.actions.test).
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "./store";
import { seg } from "./test/fixtures";

const INITIAL = useStore.getState();
beforeEach(() => useStore.setState(INITIAL, true));

describe("live filler-sound counting (upsertSegment)", () => {
  it("counts filler sounds in the user's own segments", () => {
    useStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um so uh yeah" }));
    expect(useStore.getState().filledPauseCount).toBe(2);
  });

  it("ignores the other party's segments", () => {
    useStore.getState().upsertSegment(seg({ id: "b", source: "them", text: "um uh um" }));
    expect(useStore.getState().filledPauseCount).toBe(0);
  });

  it("folds in only the delta as an interim segment grows", () => {
    const up = useStore.getState().upsertSegment;
    up(seg({ id: "a", source: "me", isFinal: false, text: "um" })); // +1
    expect(useStore.getState().filledPauseCount).toBe(1);
    up(seg({ id: "a", source: "me", isFinal: false, text: "um so uh" })); // +1 more
    expect(useStore.getState().filledPauseCount).toBe(2);
    up(seg({ id: "a", source: "me", isFinal: true, text: "um so uh, right" })); // no new filler
    expect(useStore.getState().filledPauseCount).toBe(2);
  });

  it("counts Mandarin hesitations the same as English", () => {
    useStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "嗯我覺得呃這樣" }));
    expect(useStore.getState().filledPauseCount).toBe(2);
  });

  it("does not double-count across a rewrite that drops a filler", () => {
    const up = useStore.getState().upsertSegment;
    up(seg({ id: "a", source: "me", isFinal: false, text: "um uh" })); // +2
    expect(useStore.getState().filledPauseCount).toBe(2);
    up(seg({ id: "a", source: "me", isFinal: true, text: "hello" })); // corrected → -2
    expect(useStore.getState().filledPauseCount).toBe(0);
  });

  it("does not count while viewing a replay", () => {
    useStore.setState({ appMode: "replay" });
    useStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um uh" }));
    expect(useStore.getState().filledPauseCount).toBe(0);
  });

  it("resets on a new meeting", () => {
    useStore.getState().upsertSegment(seg({ id: "a", source: "me", text: "um uh" }));
    expect(useStore.getState().filledPauseCount).toBe(2);
    useStore.getState().startMeeting();
    expect(useStore.getState().filledPauseCount).toBe(0);
    expect(useStore.getState().filledPauseCounted).toEqual({});
  });
});
