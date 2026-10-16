import { describe, it, expect, vi, beforeEach } from "vitest";

// The named actions that replaced lib modules writing the store directly
// (useStore.setState): each must write exactly the fields the inline write did,
// in one update.

vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "./store";
import { seg, replaySession } from "./test/fixtures";

const INITIAL = useStore.getInitialState();
beforeEach(() => useStore.setState(INITIAL, true));

/** Run `act` and return the changed fields + how many store updates it took. */
function effect(act: () => void) {
  const before = useStore.getState();
  let updates = 0;
  const un = useStore.subscribe(() => updates++);
  act();
  un();
  const after = useStore.getState() as unknown as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (after[k] !== (before as unknown as Record<string, unknown>)[k]) changed[k] = after[k];
  }
  return { changed, updates };
}

describe("named store actions", () => {
  it("setAnalyzedEvalSig / setDeliveryError / setBriefError / setStudyManualForId / setPostSaveDiarizingId", () => {
    const s = useStore.getState();
    expect(effect(() => s.setAnalyzedEvalSig("sig"))).toEqual({ changed: { analyzedEvalSig: "sig" }, updates: 1 });
    expect(effect(() => s.setDeliveryError("d"))).toEqual({ changed: { deliveryError: "d" }, updates: 1 });
    expect(effect(() => s.setBriefError("b"))).toEqual({ changed: { briefError: "b" }, updates: 1 });
    expect(effect(() => s.setStudyManualForId("r"))).toEqual({ changed: { studyManualForId: "r" }, updates: 1 });
    expect(effect(() => s.setPostSaveDiarizingId("e"))).toEqual({ changed: { postSaveDiarizingId: "e" }, updates: 1 });
  });

  it("restartStudyStage resets one status and pins the recording in one update", () => {
    useStore.setState({ briefStatus: "running" });
    expect(effect(() => useStore.getState().restartStudyStage("briefStatus", "rec-1"))).toEqual({
      changed: { briefStatus: "idle", studyManualForId: "rec-1" },
      updates: 1,
    });
  });

  it("invalidateDownstreamStudy resets action items, brief and delivery together", () => {
    useStore.setState({ actionItemsStatus: "done", brief: "x", briefStatus: "done", deliveryStatus: "done" });
    expect(effect(() => useStore.getState().invalidateDownstreamStudy())).toEqual({
      changed: { actionItemsStatus: "idle", brief: null, briefStatus: "idle", deliveryStatus: "idle" },
      updates: 1,
    });
  });

  it("applyDiarizedSpeakers and setSegments", () => {
    const segments = [seg({ id: "a" })];
    expect(effect(() => useStore.getState().applyDiarizedSpeakers(segments, { "them-1": "A" }))).toEqual({
      changed: { segments, speakerNames: { "them-1": "A" } },
      updates: 1,
    });
    const next = [seg({ id: "b" })];
    expect(effect(() => useStore.getState().setSegments(next))).toEqual({ changed: { segments: next }, updates: 1 });
  });

  it("applyTrimmedRecording lands the trimmed recording and resets trim, playhead and selection", () => {
    useStore.setState({ replayTrim: { startMs: 1, endMs: 2 }, replayPlayheadMs: 5, selectedFindingId: "f" });
    const replay = replaySession([]);
    const segments = [seg()];
    expect(effect(() => useStore.getState().applyTrimmedRecording({ replay, segments, findings: [], actionItems: [] }))).toEqual({
      changed: {
        replay,
        segments,
        findings: [],
        actionItems: [],
        replayTrim: null,
        replayPlayheadMs: 0,
        selectedFindingId: null,
      },
      updates: 1,
    });
  });
});
