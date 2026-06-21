import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the two boundaries the use-case crosses:
//  - the Tauri IPC `invoke` (would run the native ONNX/diarization pipeline)
//  - the logger (touches `window` under the Tauri-less path)
// Everything else under test is our own apply/mapping logic.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { runVoiceDiarize } from "./diarize";
import { useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
  invoke.mockReset();
});

describe("runVoiceDiarize (application use-case: map IPC result onto the store)", () => {
  it("rewrites each segment's speaker by id and reports counts", async () => {
    const segs = [
      seg({ id: "a", source: "them", speaker: 1, startMs: 0, endMs: 1000, text: "one" }),
      seg({ id: "b", source: "them", speaker: 1, startMs: 1000, endMs: 2000, text: "two" }),
      seg({ id: "c", source: "them", speaker: 1, startMs: 2000, endMs: 3000, text: "three" }),
    ];
    useStore.getState().enterReplay(replaySession(segs));
    // a stale name that the run must reset (clustering reshuffles numbers)
    useStore.setState({ speakerNames: { "them-1": "Stale" } });

    invoke.mockResolvedValue([
      { id: "a", speaker: 2, confidence: 0.9 },
      { id: "b", speaker: 1, confidence: 0.8 },
      { id: "c", speaker: 2, confidence: 0.7 },
    ]);

    const result = await runVoiceDiarize({ numSpeakers: null });

    // Returned summary: 3 ids assigned, 3 total final segments, 2 distinct speakers.
    expect(result).toEqual({ assigned: 3, total: 3, speakers: 2 });

    const after = useStore.getState();
    expect(after.segments.map((s) => s.speaker)).toEqual([2, 1, 2]);
    // names reset so the naming step starts clean
    expect(after.speakerNames).toEqual({});
  });

  it("passes the right IPC args (audio path, rounded spans, speaker count)", async () => {
    const segs = [seg({ id: "a", source: "them", startMs: 10.6, endMs: 999.4, text: "hi" })];
    useStore.getState().enterReplay(
      replaySession(segs, { audioPath: "/abs/rec.wav" })
    );
    invoke.mockResolvedValue([{ id: "a", speaker: 1, confidence: 1 }]);

    await runVoiceDiarize({ numSpeakers: 2 });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("diarize_audio", {
      audioPath: "/abs/rec.wav",
      segments: [{ id: "a", startMs: 11, endMs: 999 }],
      numSpeakers: 2,
    });
  });

  it("leaves segments not present in the IPC result untouched", async () => {
    const segs = [
      seg({ id: "a", source: "them", speaker: 1, startMs: 0, endMs: 1000, text: "one" }),
      seg({ id: "b", source: "them", speaker: 1, startMs: 1000, endMs: 2000, text: "two" }),
    ];
    useStore.getState().enterReplay(replaySession(segs));
    // result only reassigns "a"
    invoke.mockResolvedValue([{ id: "a", speaker: 3, confidence: 0.9 }]);

    const result = await runVoiceDiarize({ numSpeakers: null });

    expect(useStore.getState().segments.map((s) => s.speaker)).toEqual([3, 1]);
    expect(result.assigned).toBe(1);
    expect(result.speakers).toBe(3);
  });

  it("excludes trimmed and non-final segments from the spans sent to diarize", async () => {
    const segs = [
      seg({ id: "intro", source: "them", startMs: 0, endMs: 500, text: "intro" }),
      seg({ id: "keep", source: "them", startMs: 2000, endMs: 3000, text: "real" }),
      seg({ id: "partial", source: "them", startMs: 3000, endMs: 3500, text: "p", isFinal: false }),
    ];
    useStore.getState().enterReplay(replaySession(segs));
    // keep-window [1000, 5000] trims the intro (entirely before it)
    useStore.getState().setReplayTrim({ startMs: 1000, endMs: 5000 });
    invoke.mockResolvedValue([{ id: "keep", speaker: 1, confidence: 1 }]);

    const result = await runVoiceDiarize({ numSpeakers: null });

    const spansArg = invoke.mock.calls[0][1].segments as Array<{ id: string }>;
    expect(spansArg.map((s) => s.id)).toEqual(["keep"]);
    expect(result.total).toBe(1);
  });

  it("throws when no recording is loaded", async () => {
    // live mode: replay is null
    await expect(runVoiceDiarize({ numSpeakers: null })).rejects.toThrow(/no recording/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("throws when there is no transcript to diarize", async () => {
    useStore.getState().enterReplay(replaySession([]));
    await expect(runVoiceDiarize({ numSpeakers: null })).rejects.toThrow(/no transcript/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
