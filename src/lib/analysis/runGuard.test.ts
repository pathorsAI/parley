import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

// The persist side of landStage — captured, never touching Tauri.
const persistStageOutputs = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("../history/history", () => ({
  persistStageOutputs: (...args: unknown[]) => persistStageOutputs(...args),
}));

import { useStore } from "../store";
import { landStage, makeRunGuard } from "./runGuard";
import { runRegistry } from "./runRegistry";
import { replaySession, seg } from "../test/fixtures";

const INITIAL = useStore.getState();

/** Put a recording on screen the way loadHistory / an upload does. */
function show(id: string, opts: { entryId?: string | null; readOnly?: boolean } = {}) {
  useStore.setState({
    appMode: "study",
    replay: replaySession([seg({ id: "s1" })], { id }),
    loadedHistoryId: opts.readOnly ? null : opts.entryId === undefined ? id : opts.entryId,
    replayReadOnly: !!opts.readOnly,
  });
}
function leave() {
  useStore.setState({ appMode: "home", replay: null, loadedHistoryId: null, replayReadOnly: false });
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  persistStageOutputs.mockClear();
});

describe("makeRunGuard", () => {
  it("leaving pauses store writes, coming back resumes them — the run is not superseded", () => {
    const guard = makeRunGuard("findings");
    show("A");
    const run = guard.begin();
    expect(run.alive()).toBe(true);

    show("B");
    expect(run.alive()).toBe(false);
    expect(run.superseded()).toBe(false);
    // Another recording's own run of the same stage doesn't supersede it either.
    const other = guard.begin();
    expect(run.superseded()).toBe(false);

    show("A");
    expect(run.alive()).toBe(true);
    // ...and the B run can never write onto A.
    expect(other.alive()).toBe(false);
    run.end();
    other.end();
  });

  it("a newer run of the same stage on the same recording supersedes the older one", () => {
    const guard = makeRunGuard("brief");
    show("A");
    const first = guard.begin();
    const second = guard.begin();
    expect(first.superseded()).toBe(true);
    expect(first.alive()).toBe(false);
    expect(second.alive()).toBe(true);
    // Still superseded after the newer one has finished.
    second.end();
    expect(first.superseded()).toBe(true);
    first.end();
  });

  it("registers the stage as in flight for the recording until end()", () => {
    const guard = makeRunGuard("delivery");
    show("A");
    const run = guard.begin();
    expect(runRegistry.stagesFor("A").has("delivery")).toBe(true);
    run.end();
    run.end(); // idempotent
    expect(runRegistry.stagesFor("A").has("delivery")).toBe(false);
  });

  it("a run started before an upload's first save still targets — and resumes on — the saved entry", () => {
    const guard = makeRunGuard("actions");
    show("upload-1", { entryId: null });
    const run = guard.begin();
    // The auto-save files it under a new entry id; the session keeps its own.
    useStore.setState({ loadedHistoryId: "entry-9" });
    leave();
    expect(run.target()).toEqual({ entryId: "entry-9", readOnlyId: null });
    // Opening that entry from the library is the same recording.
    show("entry-9");
    expect(runRegistry.stagesFor("entry-9").has("actions")).toBe(true);
    expect(run.alive()).toBe(true);
    run.end();
  });

  it("starting a live meeting counts as leaving — a replay pass persists instead of writing into it", () => {
    const guard = makeRunGuard("findings");
    show("A");
    const run = guard.begin();
    useStore.getState().startMeeting(); // keeps `replay`, clears loadedHistoryId
    expect(run.alive()).toBe(false);
    expect(run.target()).toEqual({ entryId: "A", readOnlyId: null });
    run.end();
  });

  it("a read-only org recording targets the study cache", () => {
    const guard = makeRunGuard("brief");
    show("org-7", { readOnly: true });
    const run = guard.begin();
    leave();
    expect(run.target()).toEqual({ entryId: null, readOnlyId: "org-7" });
    run.end();
  });
});

describe("landStage", () => {
  it("on screen: applies to the store, and persists only when asked", async () => {
    const guard = makeRunGuard("actions");
    show("A");
    const run = guard.begin();
    const apply = vi.fn();
    await landStage(run, { stage: "actions", apply, patch: { analyzed: true } });
    expect(apply).toHaveBeenCalledOnce();
    expect(persistStageOutputs).not.toHaveBeenCalled();
    expect(runRegistry.stagesFor("A").size).toBe(0);

    const run2 = guard.begin();
    await landStage(run2, { stage: "actions", apply, patch: { analyzed: true }, persistWhileLoaded: true });
    expect(persistStageOutputs).toHaveBeenCalledWith(
      { entryId: "A", readOnlyId: null },
      { analyzed: true },
      { push: true },
    );
  });

  it("left: writes the result onto that entry and never touches the store", async () => {
    const guard = makeRunGuard("findings");
    show("A");
    const run = guard.begin();
    show("B");
    const apply = vi.fn();
    await landStage(run, { stage: "findings", apply, patch: { findings: [] } });
    expect(apply).not.toHaveBeenCalled();
    expect(persistStageOutputs).toHaveBeenCalledWith(
      { entryId: "A", readOnlyId: null },
      { findings: [] },
      { push: true },
    );
    expect(runRegistry.stagesFor("A").size).toBe(0);
  });

  it("left, then came back while the result was being saved: lands in the store too", async () => {
    const guard = makeRunGuard("brief");
    show("A");
    const run = guard.begin();
    leave();
    persistStageOutputs.mockImplementationOnce(async () => {
      // The user reopens A mid-write; loadHistory would show the stage "running".
      expect(runRegistry.stagesFor("A").has("brief")).toBe(true);
      show("A");
    });
    const apply = vi.fn();
    await landStage(run, { stage: "brief", apply, patch: { brief: "b" } });
    expect(apply).toHaveBeenCalledOnce();
    expect(runRegistry.stagesFor("A").size).toBe(0);
  });

  it("superseded: dropped — neither applied nor persisted", async () => {
    const guard = makeRunGuard("brief");
    show("A");
    const old = guard.begin();
    const fresh = guard.begin();
    const apply = vi.fn();
    await landStage(old, { stage: "brief", apply, patch: { brief: "stale" } });
    expect(apply).not.toHaveBeenCalled();
    expect(persistStageOutputs).not.toHaveBeenCalled();
    fresh.end();
  });

  it("left an unsaved upload: nothing to write onto", async () => {
    const guard = makeRunGuard("findings");
    show("upload-2", { entryId: null });
    const run = guard.begin();
    leave();
    await landStage(run, { stage: "findings", apply: vi.fn(), patch: { findings: [] } });
    expect(persistStageOutputs).not.toHaveBeenCalled();
  });
});
