import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the two boundaries the module crosses: the Tauri IPC `invoke` (would run
// the native ONNX/diarization pipeline) and the logger (touches `window` under
// the Tauri-less path). The remap + patch logic under test is our own.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { remapToPriorSpeakers, rediarizeSegments, type PriorSeg } from "./postDiarize";
import { seg } from "../test/fixtures";

beforeEach(() => invoke.mockReset());

/** Shorthand prior entry. */
function p(id: string, speaker: number, weightMs = 1000): PriorSeg {
  return { id, speaker, weightMs };
}

describe("remapToPriorSpeakers (cluster → prior speaker numbering)", () => {
  it("keeps agreeing labels: each cluster claims the prior speaker it overlaps most", () => {
    // Clustering numbered the sides opposite to the provider — the mapping must
    // follow the overlap, not the cluster numbers.
    const prior = [p("a", 1), p("b", 2), p("c", 1)];
    const assigned = [
      { id: "a", speaker: 2 },
      { id: "b", speaker: 1 },
      { id: "c", speaker: 2 },
    ];
    expect(remapToPriorSpeakers(prior, assigned)).toEqual(
      new Map([
        [2, 1],
        [1, 2],
      ]),
    );
  });

  it("weights claims by speech duration, not line count", () => {
    // Cluster 1 has TWO short lines labelled 2 but ONE long line labelled 1 —
    // the long line outweighs them, so cluster 1 keeps number 1.
    const prior = [p("a", 1, 10_000), p("b", 2, 1000), p("c", 2, 1000), p("d", 2, 9000)];
    const assigned = [
      { id: "a", speaker: 1 },
      { id: "b", speaker: 1 },
      { id: "c", speaker: 1 },
      { id: "d", speaker: 2 },
    ];
    expect(remapToPriorSpeakers(prior, assigned)).toEqual(
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
  });

  it("folds a spurious late provider speaker back into the real one", () => {
    // The provider invented speaker 3 late in the meeting for the same voice as
    // speaker 1; the audio puts both in one cluster, which maps to 1 (more ms).
    const prior = [p("a", 1, 5000), p("b", 3, 2000), p("c", 2, 4000)];
    const assigned = [
      { id: "a", speaker: 1 },
      { id: "b", speaker: 1 },
      { id: "c", speaker: 2 },
    ];
    expect(remapToPriorSpeakers(prior, assigned)).toEqual(
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
  });

  it("gives an unmatched cluster a fresh number above every prior number", () => {
    // Two clusters both overlap prior speaker 1 best; the stronger claim wins
    // and the loser gets a number no prior speaker used (here 3, above 1 and 2).
    const prior = [p("a", 1, 5000), p("b", 1, 1000), p("c", 2, 4000)];
    const assigned = [
      { id: "a", speaker: 1 },
      { id: "b", speaker: 2 },
      { id: "c", speaker: 3 },
    ];
    expect(remapToPriorSpeakers(prior, assigned)).toEqual(
      new Map([
        [1, 1],
        [3, 2],
        [2, 3],
      ]),
    );
  });

  it("never maps a cluster to prior speaker 0 (unknown)", () => {
    const prior = [p("a", 0), p("b", 0)];
    const assigned = [
      { id: "a", speaker: 1 },
      { id: "b", speaker: 2 },
    ];
    // No claimable priors → both clusters get fresh numbers starting at 1.
    expect(remapToPriorSpeakers(prior, assigned)).toEqual(
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
  });
});

describe("rediarizeSegments (audio-based correction of a saved live meeting)", () => {
  it("skips mic-only meetings (no 'mix' segments) without touching the IPC", async () => {
    const segs = [
      seg({ id: "a", source: "me", speaker: 0, text: "hi" }),
      seg({ id: "b", source: "them", speaker: 0, text: "yo" }),
    ];
    expect(await rediarizeSegments(segs, "/rec.ogg")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("re-labels drifted lines while keeping stable ones and non-mix segments", async () => {
    const segs = [
      seg({ id: "a", source: "mix", speaker: 1, startMs: 0, endMs: 5000, text: "one" }),
      seg({ id: "b", source: "mix", speaker: 2, startMs: 5000, endMs: 9000, text: "two" }),
      // Late line the provider drifted onto speaker 1 — the audio says it's 2.
      seg({ id: "c", source: "mix", speaker: 1, startMs: 9000, endMs: 10_000, text: "three" }),
      // Interim + empty lines never reach the clusterer and stay untouched.
      seg({ id: "d", source: "mix", speaker: 1, isFinal: false, text: "partial" }),
    ];
    invoke.mockResolvedValue([
      { id: "a", speaker: 1, confidence: 0.9 },
      { id: "b", speaker: 2, confidence: 0.9 },
      { id: "c", speaker: 2, confidence: 0.8 },
    ]);

    const result = await rediarizeSegments(segs, "/rec.ogg");

    expect(invoke).toHaveBeenCalledWith("diarize_audio", {
      audioPath: "/rec.ogg",
      segments: [
        { id: "a", startMs: 0, endMs: 5000 },
        { id: "b", startMs: 5000, endMs: 9000 },
        { id: "c", startMs: 9000, endMs: 10_000 },
      ],
      numSpeakers: null,
    });
    expect(result?.changed).toBe(1);
    expect(result?.segments.map((s) => s.speaker)).toEqual([1, 2, 2, 1]);
    // Unchanged segments keep their identity (no needless object churn).
    expect(result?.segments[0]).toBe(segs[0]);
    expect(result?.segments[3]).toBe(segs[3]);
  });

  it("returns null when the audio agrees with the provider (nothing changed)", async () => {
    const segs = [
      seg({ id: "a", source: "mix", speaker: 1, startMs: 0, endMs: 1000, text: "one" }),
      seg({ id: "b", source: "mix", speaker: 2, startMs: 1000, endMs: 2000, text: "two" }),
    ];
    invoke.mockResolvedValue([
      { id: "a", speaker: 1, confidence: 1 },
      { id: "b", speaker: 2, confidence: 1 },
    ]);
    expect(await rediarizeSegments(segs, "/rec.ogg")).toBeNull();
  });
});
