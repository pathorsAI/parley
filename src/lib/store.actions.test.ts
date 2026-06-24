import { describe, it, expect, beforeEach, vi } from "vitest";

// The store calls `log.*`, whose Tauri-less path touches `window`. We don't test
// logging — it's a side-channel boundary — so stub the module to a no-op.
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "./store";
import { seg, replaySession } from "./test/fixtures";
import type { TimelineEvent } from "./types";

// Snapshot the pristine initial state once, then restore before every test so
// each case drives the store from a known baseline (the store is a singleton).
const INITIAL = useStore.getState();
function resetStore() {
  useStore.setState(INITIAL, true);
}

function makeFinding(id: string): TimelineEvent {
  return {
    id,
    atMs: 1000,
    side: "them",
    severity: "warn",
    source: "extra",
    title: "moment",
    detail: "something happened",
  };
}

beforeEach(() => {
  resetStore();
});

describe("enterReplay / exitReplay", () => {
  it("enterReplay loads the session and resets analysis slices", () => {
    // Seed some live-mode cruft that entering replay must clear.
    useStore.setState({
      findings: [makeFinding("old")],
      selectedFindingId: "old",
      analysisStatus: "done",
      actionItems: [
        { id: "ai", text: "x", rationale: "y", done: false, linkedEventId: null, atMs: null },
      ],
    });

    const session = replaySession(
      [seg({ id: "s1", text: "hi", startMs: 0, endMs: 1000 })],
      { speakerNames: { "them-1": "Alice" } }
    );
    useStore.getState().enterReplay(session);

    const s = useStore.getState();
    expect(s.appMode).toBe("replay");
    expect(s.replay).toBe(session);
    expect(s.segments).toEqual(session.segments);
    expect(s.speakerNames).toEqual({ "them-1": "Alice" });
    expect(s.meetingStatus).toBe("stopped");
    expect(s.replayPlayheadMs).toBe(0);
    expect(s.replayTrim).toBeNull();
    // analysis slices fully reset
    expect(s.findings).toEqual([]);
    expect(s.selectedFindingId).toBeNull();
    expect(s.analysisStatus).toBe("idle");
    expect(s.actionItems).toEqual([]);
  });

  it("exitReplay returns to a clean live/idle state", () => {
    const session = replaySession([seg({ id: "s1" })]);
    useStore.getState().enterReplay(session);
    // Simulate having opened the wizard + run analysis during replay.
    useStore.setState({ analysisGate: "deferred", findings: [makeFinding("f1")] });

    useStore.getState().exitReplay();

    const s = useStore.getState();
    expect(s.appMode).toBe("live");
    expect(s.replay).toBeNull();
    expect(s.segments).toEqual([]);
    expect(s.speakerNames).toEqual({});
    expect(s.meetingStatus).toBe("idle");
    expect(s.analysisGate).toBe("open");
    expect(s.findings).toEqual([]);
    expect(s.replayTrim).toBeNull();
  });
});

describe("ingest wizard + analysis gate", () => {
  it("openIngestWizard arms the deferred gate and sets step/path", () => {
    expect(useStore.getState().analysisGate).toBe("open");

    useStore.getState().openIngestWizard("/tmp/rec.wav");

    const s = useStore.getState();
    expect(s.ingestWizardOpen).toBe(true);
    expect(s.ingestWizardStep).toBe("count");
    expect(s.ingestWizardError).toBeNull();
    expect(s.ingestAudioPath).toBe("/tmp/rec.wav");
    // Loading the session behind the dialog must NOT auto-analyze.
    expect(s.analysisGate).toBe("deferred");
  });

  it("releaseAnalysisGate opens the gate (the review-confirm path)", () => {
    useStore.getState().openIngestWizard("/tmp/rec.wav");
    useStore.getState().releaseAnalysisGate();
    expect(useStore.getState().analysisGate).toBe("open");
  });

  it("setIngestWizardStep records the step and optional error", () => {
    useStore.getState().setIngestWizardStep("error", "boom");
    let s = useStore.getState();
    expect(s.ingestWizardStep).toBe("error");
    expect(s.ingestWizardError).toBe("boom");

    // step change without an error clears the prior error
    useStore.getState().setIngestWizardStep("transcribing");
    s = useStore.getState();
    expect(s.ingestWizardStep).toBe("transcribing");
    expect(s.ingestWizardError).toBeNull();
  });

  it("closeIngestWizard closes the dialog and clears the picked path", () => {
    useStore.getState().openIngestWizard("/tmp/rec.wav");
    useStore.getState().closeIngestWizard();
    const s = useStore.getState();
    expect(s.ingestWizardOpen).toBe(false);
    expect(s.ingestAudioPath).toBeNull();
  });
});

describe("replay playhead + trim", () => {
  it("setReplayPlayhead clamps negatives to 0", () => {
    useStore.getState().setReplayPlayhead(2500);
    expect(useStore.getState().replayPlayheadMs).toBe(2500);
    useStore.getState().setReplayPlayhead(-100);
    expect(useStore.getState().replayPlayheadMs).toBe(0);
  });

  it("setReplayTrim sets and clears the keep-window", () => {
    useStore.getState().setReplayTrim({ startMs: 1000, endMs: 5000 });
    expect(useStore.getState().replayTrim).toEqual({ startMs: 1000, endMs: 5000 });
    useStore.getState().setReplayTrim(null);
    expect(useStore.getState().replayTrim).toBeNull();
  });
});

describe("findings selection invalidation", () => {
  it("setFindings replaces the list and clears selection + cached solutions", () => {
    useStore.setState({
      findings: [makeFinding("old")],
      selectedFindingId: "old",
      findingSolutions: { old: { status: "done", solution: null, error: null } },
    });

    const next = [makeFinding("new1"), makeFinding("new2")];
    useStore.getState().setFindings(next);

    const s = useStore.getState();
    expect(s.findings).toEqual(next);
    // model mints fresh ids each pass → old selection + solutions are stale
    expect(s.selectedFindingId).toBeNull();
    expect(s.findingSolutions).toEqual({});
  });

  it("keeps the selection + its solution when the finding survives (streaming partials)", () => {
    const entry = { status: "done", solution: null, error: null } as const;
    useStore.setState({
      findings: [makeFinding("a")],
      selectedFindingId: "a",
      findingSolutions: { a: { ...entry }, gone: { ...entry } },
    });

    // A later streamed partial commits a growing list with STABLE ids: "a" is
    // still present (plus a newly-completed "b"); the no-longer-present "gone" drops.
    const next = [makeFinding("a"), makeFinding("b")];
    useStore.getState().setFindings(next);

    const s = useStore.getState();
    expect(s.findings).toEqual(next);
    expect(s.selectedFindingId).toBe("a"); // survived the partial → still open
    expect(s.findingSolutions).toEqual({ a: { ...entry } }); // its solution preserved; "gone" cleared
  });

  it("updateFinding patches one finding in place and never rewrites its id", () => {
    useStore.setState({ findings: [makeFinding("a"), makeFinding("b")] });

    // Patch includes an id field, which must be ignored — the keyed id stays "a".
    useStore.getState().updateFinding("a", {
      title: "edited",
      severity: "critical",
      id: "hijack",
    } as Partial<TimelineEvent>);

    const s = useStore.getState();
    const a = s.findings.find((f) => f.title === "edited");
    expect(a?.id).toBe("a");
    expect(a?.severity).toBe("critical");
    expect(a?.detail).toBe("something happened"); // untouched field preserved
    expect(s.findings.find((f) => f.id === "b")?.title).toBe("moment"); // sibling untouched
    expect(s.findings.some((f) => f.id === "hijack")).toBe(false);
  });

  it("removeFinding deletes one finding and clears its selection + solution", () => {
    const entry = { status: "done", solution: null, error: null } as const;
    useStore.setState({
      findings: [makeFinding("a"), makeFinding("b")],
      selectedFindingId: "a",
      solutionFindingId: "a",
      findingSolutions: { a: { ...entry }, b: { ...entry } },
    });

    useStore.getState().removeFinding("a");

    const s = useStore.getState();
    expect(s.findings.map((f) => f.id)).toEqual(["b"]);
    expect(s.selectedFindingId).toBeNull();
    expect(s.solutionFindingId).toBeNull();
    expect(s.findingSolutions).toEqual({ b: { ...entry } });
  });

  it("setFindingSolution merges a patch into the per-finding entry", () => {
    useStore.getState().setFindingSolution("f1", { status: "running" });
    expect(useStore.getState().findingSolutions.f1).toEqual({
      status: "running",
      solution: null,
      error: null,
    });

    useStore.getState().setFindingSolution("f1", { status: "error", error: "nope" });
    expect(useStore.getState().findingSolutions.f1).toEqual({
      status: "error",
      solution: null,
      error: "nope",
    });
  });
});

describe("transcript upsert (partial → final in place)", () => {
  it("appends a new segment and replaces an existing one by id", () => {
    const partial = seg({ id: "s1", text: "hel", isFinal: false });
    useStore.getState().upsertSegment(partial);
    expect(useStore.getState().segments).toEqual([partial]);

    const final = seg({ id: "s1", text: "hello", isFinal: true });
    useStore.getState().upsertSegment(final);
    // replaced in place, not appended
    expect(useStore.getState().segments).toEqual([final]);

    const second = seg({ id: "s2", text: "world" });
    useStore.getState().upsertSegment(second);
    expect(useStore.getState().segments).toEqual([final, second]);
  });

  it("clearTranscript empties the segment list", () => {
    useStore.getState().upsertSegment(seg({ id: "s1" }));
    useStore.getState().clearTranscript();
    expect(useStore.getState().segments).toEqual([]);
  });
});

describe("speaker names", () => {
  it("setSpeakerName assigns a trimmed name and deletes on empty", () => {
    useStore.getState().setSpeakerName("them-1", "  Alice  ");
    expect(useStore.getState().speakerNames).toEqual({ "them-1": "Alice" });

    useStore.getState().setSpeakerName("them-1", "   ");
    expect(useStore.getState().speakerNames).toEqual({});
  });
});

describe("meeting lifecycle", () => {
  it("startMeeting resets the transcript + analysis and marks recording", () => {
    useStore.setState({ segments: [seg({ id: "old" })], findings: [makeFinding("f")] });

    useStore.getState().startMeeting();

    const s = useStore.getState();
    expect(s.meetingStatus).toBe("recording");
    expect(typeof s.meetingStartedAt).toBe("number");
    expect(s.segments).toEqual([]);
    expect(s.findings).toEqual([]);
    expect(s.speakerNames).toEqual({});
  });

  it("stopMeeting only flips the status", () => {
    useStore.getState().startMeeting();
    useStore.getState().stopMeeting();
    expect(useStore.getState().meetingStatus).toBe("stopped");
  });
});

describe("todos + action items", () => {
  it("addTodo ignores blank input and appends real items", () => {
    useStore.getState().addTodo("   ");
    expect(useStore.getState().todos).toEqual([]);

    useStore.getState().addTodo("  ask about budget ");
    const todos = useStore.getState().todos;
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ text: "ask about budget", done: false });
    expect(typeof todos[0].id).toBe("string");
  });

  it("toggleTodo flips done by id", () => {
    useStore.getState().addTodo("item");
    const id = useStore.getState().todos[0].id;
    useStore.getState().toggleTodo(id);
    expect(useStore.getState().todos[0].done).toBe(true);
    useStore.getState().toggleTodo(id);
    expect(useStore.getState().todos[0].done).toBe(false);
  });

  it("markTodosDone marks only the given ids done", () => {
    useStore.getState().applyTodoTemplate(["a", "b", "c"]);
    const [a, b] = useStore.getState().todos;
    useStore.getState().markTodosDone([a.id, b.id]);
    const todos = useStore.getState().todos;
    expect(todos.map((t) => t.done)).toEqual([true, true, false]);
  });

  it("applyTodoTemplate replaces the checklist (blank items dropped, all unchecked)", () => {
    useStore.getState().addTodo("stale");
    useStore.getState().applyTodoTemplate(["  agenda 1 ", "", "agenda 2"]);
    const todos = useStore.getState().todos;
    expect(todos.map((t) => t.text)).toEqual(["agenda 1", "agenda 2"]);
    expect(todos.every((t) => !t.done)).toBe(true);
  });

  it("toggleActionItem flips done by id", () => {
    useStore.setState({
      actionItems: [
        { id: "x", text: "follow up", rationale: "r", done: false, linkedEventId: null, atMs: null },
      ],
    });
    useStore.getState().toggleActionItem("x");
    expect(useStore.getState().actionItems[0].done).toBe(true);
  });
});

describe("autoAnalyze interval floor", () => {
  it("setAutoAnalyzeSec clamps to a 20s minimum and defaults 0/NaN to 45", () => {
    useStore.getState().setAutoAnalyzeSec(10);
    expect(useStore.getState().autoAnalyzeSec).toBe(20);
    useStore.getState().setAutoAnalyzeSec(90);
    expect(useStore.getState().autoAnalyzeSec).toBe(90);
    useStore.getState().setAutoAnalyzeSec(0);
    expect(useStore.getState().autoAnalyzeSec).toBe(45);
  });
});
