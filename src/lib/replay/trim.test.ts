import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { trimRecording } from "./trim";
import { useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";

const INITIAL = useStore.getInitialState();
beforeEach(() => useStore.setState(INITIAL, true));

const finding = (id: string, atMs: number) => ({
  id, atMs, side: "them" as const, severity: "warn" as const, source: "extra" as const, title: id, detail: "",
});

describe("trimRecording", () => {
  it("rebases what overlaps the window onto 0 in one store update", async () => {
    const session = replaySession(
      [
        seg({ id: "a", startMs: 0, endMs: 900 }),
        seg({ id: "b", startMs: 900, endMs: 2100 }),
        seg({ id: "c", startMs: 5000, endMs: 6000 }),
      ],
      { audioOffsetMs: 100 },
    );
    useStore.getState().enterReplay(session);
    useStore.setState({
      findings: [finding("in", 1500), finding("out", 4000)],
      actionItems: [
        { id: "x", text: "", done: false, linkedEventId: null, atMs: 1200 },
        { id: "y", text: "", done: false, linkedEventId: null, atMs: 9000 },
        { id: "z", text: "", done: false, linkedEventId: null, atMs: null },
      ],
      replayTrim: { startMs: 1000, endMs: 3000 },
      replayPlayheadMs: 2000,
      selectedFindingId: "in",
    });
    let updates = 0;
    const un = useStore.subscribe(() => updates++);
    await trimRecording({ startMs: 1000.4, endMs: 3000 });
    un();
    const s = useStore.getState();
    expect(updates).toBe(1);
    expect(s.segments.map((x) => [x.id, x.startMs, x.endMs])).toEqual([["b", 0, 1100]]);
    expect(s.replay?.segments).toBe(s.segments);
    expect(s.replay?.durationMs).toBe(2000);
    expect(s.replay?.audioOffsetMs).toBe(1100);
    expect(s.findings.map((f) => [f.id, f.atMs])).toEqual([["in", 500]]);
    expect(s.actionItems.map((a) => [a.id, a.atMs])).toEqual([["x", 200], ["z", null]]);
    expect(s.replayTrim).toBeNull();
    expect(s.replayPlayheadMs).toBe(0);
    expect(s.selectedFindingId).toBeNull();
  });

  it("does nothing for an empty window and throws with no recording", async () => {
    await expect(trimRecording({ startMs: 0, endMs: 10 })).rejects.toThrow();
    useStore.getState().enterReplay(replaySession([seg()]));
    const before = useStore.getState();
    await trimRecording({ startMs: 50, endMs: 50 });
    expect(useStore.getState()).toBe(before);
  });
});
