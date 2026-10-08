import { afterEach, describe, expect, it, vi } from "vitest";

// Manual regeneration of a stage that is still RUNNING — the way out of a pass
// whose model call hung. It used to be a silent no-op (and the chip disabled the
// buttons), so a stalled findings pass meant "generating" forever.

const { log, runners } = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  runners: {
    runAnalysis: vi.fn<(opts?: { force?: boolean }) => Promise<void>>(async () => {}),
    cancelAnalysis: vi.fn(() => true),
    runActionItems: vi.fn(async () => {}),
    cancelActionItems: vi.fn(() => true),
    runBriefGeneration: vi.fn(async () => {}),
    cancelBriefGeneration: vi.fn(() => true),
    runDeliveryAnalysis: vi.fn(async () => {}),
    cancelDeliveryAnalysis: vi.fn(() => true),
    runFilingSuggestion: vi.fn(async () => {}),
    cancelFilingSuggestion: vi.fn(() => true),
  },
}));
vi.mock("../log", () => ({ log }));
vi.mock("./engine", () => ({ runAnalysis: runners.runAnalysis, cancelAnalysis: runners.cancelAnalysis }));
vi.mock("./actionItems", () => ({
  runActionItems: runners.runActionItems,
  cancelActionItems: runners.cancelActionItems,
}));
vi.mock("./briefRun", () => ({
  runBriefGeneration: runners.runBriefGeneration,
  cancelBriefGeneration: runners.cancelBriefGeneration,
}));
vi.mock("./deliveryRun", () => ({
  runDeliveryAnalysis: runners.runDeliveryAnalysis,
  cancelDeliveryAnalysis: runners.cancelDeliveryAnalysis,
}));
vi.mock("./filingRun", () => ({
  runFilingSuggestion: runners.runFilingSuggestion,
  cancelFilingSuggestion: runners.cancelFilingSuggestion,
}));
vi.mock("../history/history", () => ({
  persistReadOnlyStudyOutputs: vi.fn(async () => {}),
  saveUploadToHistory: vi.fn(async () => {}),
}));

import { useStore } from "../store";
import { reanalyzeAll, regenerateArtifact } from "./studyPipeline";
import { replaySession, seg } from "../test/fixtures";

const INITIAL = useStore.getState();

function show(id: string) {
  useStore.setState({
    appMode: "study",
    replay: replaySession([seg({ text: "hi" })], { id }),
    segments: [seg({ text: "hi" })],
    loadedHistoryId: id,
  });
}

afterEach(() => {
  useStore.setState(INITIAL, true);
  for (const fn of Object.values(runners)) fn.mockClear();
  log.warn.mockClear();
});

describe("regenerateArtifact on a running stage", () => {
  it("cancels the hung findings pass and resets it so a fresh one starts", () => {
    show("A");
    useStore.setState({ analysisStatus: "running" });
    regenerateArtifact("findings");
    expect(runners.cancelAnalysis).toHaveBeenCalledTimes(1);
    expect(useStore.getState().analysisStatus).toBe("idle");
    expect(useStore.getState().studyManualForId).toBe("A");
  });

  it("cancels through the stage's own guard", () => {
    show("A");
    useStore.setState({ briefStatus: "running" });
    regenerateArtifact("brief");
    expect(runners.cancelBriefGeneration).toHaveBeenCalledTimes(1);
    expect(runners.cancelAnalysis).not.toHaveBeenCalled();
    expect(useStore.getState().briefStatus).toBe("idle");
  });

  it("does not cancel anything for a settled stage", () => {
    show("A");
    useStore.setState({ actionItemsStatus: "error" });
    regenerateArtifact("actions");
    expect(runners.cancelActionItems).not.toHaveBeenCalled();
    expect(useStore.getState().actionItemsStatus).toBe("idle");
  });
});

describe("reanalyzeAll", () => {
  it("replaces a running findings pass and re-queues everything downstream once it lands", async () => {
    show("A");
    useStore.setState({ analysisStatus: "running", actionItemsStatus: "done", briefStatus: "done" });
    runners.runAnalysis.mockImplementation(async () => {
      // The runner's own lock: it only starts from a non-running status.
      if (useStore.getState().analysisStatus === "running") return;
      useStore.setState({ analysisStatus: "running" });
      await Promise.resolve();
      useStore.setState({ analysisStatus: "done" });
    });
    await reanalyzeAll();
    expect(runners.cancelAnalysis).toHaveBeenCalledTimes(1);
    expect(runners.runAnalysis).toHaveBeenCalledWith({ mode: "replay", force: true });
    const s = useStore.getState();
    expect(s.analysisStatus).toBe("done");
    expect(s.actionItemsStatus).toBe("idle");
    expect(s.briefStatus).toBe("idle");
  });

  it("waits for a findings pass it did not start itself to settle", async () => {
    show("A");
    // Another dispatch owns the pass: the direct call is a no-op.
    runners.runAnalysis.mockImplementation(async () => {
      useStore.setState({ analysisStatus: "running" });
      setTimeout(() => useStore.setState({ analysisStatus: "done" }), 5);
    });
    useStore.setState({ actionItemsStatus: "done" });
    await reanalyzeAll();
    expect(useStore.getState().actionItemsStatus).toBe("idle");
  });

  it("cancels downstream runs still in flight before re-queueing them", async () => {
    show("A");
    // A brief (and action items) hung against the old findings: without the
    // cancel, the brief would land "done" with stale text and never re-run.
    useStore.setState({ actionItemsStatus: "running", briefStatus: "running", deliveryStatus: "done" });
    runners.runAnalysis.mockImplementation(async () => {
      useStore.setState({ analysisStatus: "done" });
    });
    const order: string[] = [];
    runners.cancelBriefGeneration.mockImplementationOnce(() => {
      order.push(`cancel brief while ${useStore.getState().briefStatus}`);
      return true;
    });
    await reanalyzeAll();
    expect(runners.cancelActionItems).toHaveBeenCalledTimes(1);
    expect(runners.cancelBriefGeneration).toHaveBeenCalledTimes(1);
    expect(runners.cancelDeliveryAnalysis).toHaveBeenCalledTimes(1);
    expect(runners.cancelFilingSuggestion).not.toHaveBeenCalled();
    // Cancelled before the reset, so the stale run is superseded first.
    expect(order).toEqual(["cancel brief while running"]);
    const s = useStore.getState();
    expect(s.actionItemsStatus).toBe("idle");
    expect(s.briefStatus).toBe("idle");
    expect(s.deliveryStatus).toBe("idle");
  });

  it("leaves downstream runs alone when the fresh findings did not complete", async () => {
    show("A");
    useStore.setState({ briefStatus: "running" });
    runners.runAnalysis.mockImplementation(async () => {
      useStore.setState({ analysisStatus: "error" });
    });
    await reanalyzeAll();
    expect(runners.cancelBriefGeneration).not.toHaveBeenCalled();
    expect(useStore.getState().briefStatus).toBe("running");
  });

  it("says why it did nothing when no recording is loaded", async () => {
    await reanalyzeAll();
    expect(runners.runAnalysis).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
