import { describe, it, expect, vi } from "vitest";

// history.ts pulls in `log` (whose Tauri-less path touches `window`); we only
// exercise the pure `buildSummary` here, so stub the side-channel to a no-op.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildSummary, mergeAnalysisSnapshot, mergeStageOutputs, type AnalysisSnapshot } from "./history";
import type { HistoryEntry } from "./types";
import type { DeliveryAssessment } from "../types";
import { seg } from "../test/fixtures";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h1",
    title: "Negotiation",
    source: "live",
    createdAt: 1000,
    durationMs: 5000,
    segments: [],
    speakerNames: {},
    findings: [],
    actionItems: [],
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: "audio.ogg",
    ...overrides,
  };
}

describe("buildSummary", () => {
  it("mirrors the analyzed flag onto the summary card (absent stays absent)", () => {
    expect(buildSummary(entry({ analyzed: true })).analyzed).toBe(true);
    expect(buildSummary(entry({ analyzed: false })).analyzed).toBe(false);
    expect(buildSummary(entry()).analyzed).toBeUndefined();
  });

  it("counts distinct speakers by source+speaker, ignoring empty-text turns", () => {
    const s = buildSummary(
      entry({
        segments: [
          seg({ id: "a", source: "them", speaker: 1, text: "hi", startMs: 100 }),
          seg({ id: "b", source: "them", speaker: 2, text: "yo", startMs: 200 }),
          seg({ id: "c", source: "me", speaker: 1, text: "", startMs: 50 }), // empty → ignored
        ],
      }),
    );
    expect(s.speakerCount).toBe(2);
  });

  it("derives the snippet from the earliest spoken final segment", () => {
    const s = buildSummary(
      entry({
        segments: [
          seg({ id: "c", source: "me", speaker: 1, text: "", startMs: 50 }),
          seg({ id: "a", source: "them", speaker: 1, text: "opening line", startMs: 100 }),
          seg({ id: "b", source: "them", speaker: 1, text: "later line", startMs: 200 }),
        ],
      }),
    );
    expect(s.snippet).toBe("opening line");
  });

  it("truncates a long snippet to 90 chars + ellipsis", () => {
    const long = "x".repeat(120);
    const s = buildSummary(entry({ segments: [seg({ text: long, startMs: 0 })] }));
    expect(s.snippet).toHaveLength(91);
    expect(s.snippet.endsWith("…")).toBe(true);
  });

  it("mirrors findings count, audio presence, and passthrough fields", () => {
    const withAudio = buildSummary(
      entry({
        findings: [
          { id: "f1", atMs: 0, side: "me", severity: "warn", source: "extra", title: "t", detail: "d" },
        ],
      }),
    );
    expect(withAudio.findingsCount).toBe(1);
    expect(withAudio.hasAudio).toBe(true);
    expect(withAudio.title).toBe("Negotiation");
    expect(withAudio.source).toBe("live");

    const noAudio = buildSummary(entry({ audio: null }));
    expect(noAudio.hasAudio).toBe(false);
  });

  it("passes folderId through, defaulting to null when absent", () => {
    expect(buildSummary(entry({ folderId: "fld-1" })).folderId).toBe("fld-1");
    expect(buildSummary(entry()).folderId).toBeNull();
  });
});

const finding = { id: "f1", atMs: 0, side: "me", severity: "warn", source: "extra", title: "t", detail: "d" } as const;
const delivery: DeliveryAssessment = {
  tone: "firm",
  toneEvidence: "",
  fillers: { level: "ok", examples: [], note: "" },
  pace: "comfortable",
  summary: "ok",
};

describe("mergeStageOutputs (one stage's result onto a saved entry)", () => {
  it("moves only the stage's own fields", () => {
    const saved = entry({ brief: "old brief", deliveryAssessment: delivery, title: "Kept" });
    const next = mergeStageOutputs(saved, { findings: [finding], meetingKind: "sales" });
    expect(next.findings).toEqual([finding]);
    expect(next.meetingKind).toBe("sales");
    expect(next.brief).toBe("old brief");
    expect(next.deliveryAssessment).toEqual(delivery);
    expect(next.title).toBe("Kept");
    // The findings pass alone never claims the pipeline completed.
    expect(next.analyzed).toBeUndefined();
  });

  it("action items land with the findings they ran on and mark the pipeline complete", () => {
    const next = mergeStageOutputs(entry(), {
      findings: [finding],
      actionItems: [{ id: "a", text: "x", done: false, linkedEventId: null, atMs: null }],
      analyzed: true,
      meetingKind: null,
    });
    expect(next.analyzed).toBe(true);
    expect(next.actionItems).toHaveLength(1);
  });

  it("never erases a saved kind or brief with an empty value", () => {
    const saved = entry({ meetingKind: "pricing", brief: "good brief" });
    const next = mergeStageOutputs(saved, { meetingKind: null, brief: "" });
    expect(next.meetingKind).toBe("pricing");
    expect(next.brief).toBe("good brief");
  });

  it("records a brief failure, and a later brief clears it", () => {
    const failed = mergeStageOutputs(entry(), { briefFailed: true });
    expect(failed.briefFailed).toBe(true);
    const ok = mergeStageOutputs(failed, { brief: "# Brief", briefFailed: false });
    expect(ok.brief).toBe("# Brief");
    expect(ok.briefFailed).toBe(false);
  });

  it("copies a null filing suggestion authoritatively (the pass had nothing to propose)", () => {
    const saved = entry({ filingSuggestion: { title: "Old", folders: [] } });
    const next = mergeStageOutputs(saved, { filingSuggestion: null, filingSuggested: true });
    expect(next.filingSuggestion).toBeNull();
    expect(next.filingSuggested).toBe(true);
  });
});

describe("mergeAnalysisSnapshot (the completed-pipeline overwrite)", () => {
  function snap(over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
    return {
      segments: [],
      speakerNames: {},
      findings: [finding],
      actionItems: [],
      analyzed: true,
      meetingContext: "",
      meetingBatna: "",
      meetingTarget: "",
      meetingFloor: "",
      deliveryAssessment: null,
      speechRateHz: null,
      brief: null,
      briefFailed: false,
      filingSuggestion: null,
      filingSuggested: false,
      meetingKind: null,
      ...over,
    };
  }

  it("a sibling stage still generating at snapshot time can't erase what it saved since", () => {
    const saved = entry({
      deliveryAssessment: delivery,
      brief: "landed brief",
      meetingKind: "sales",
      filingSuggestion: { title: "T", folders: [] },
      filingSuggested: true,
    });
    const next = mergeAnalysisSnapshot(saved, snap());
    expect(next.findings).toEqual([finding]);
    expect(next.analyzed).toBe(true);
    expect(next.deliveryAssessment).toEqual(delivery);
    expect(next.brief).toBe("landed brief");
    expect(next.meetingKind).toBe("sales");
    expect(next.filingSuggested).toBe(true);
    expect(next.filingSuggestion).toEqual({ title: "T", folders: [] });
  });

  it("a filing answer the user gave (done, suggestion null) is copied", () => {
    const saved = entry({ filingSuggestion: { title: "T", folders: [] }, filingSuggested: true });
    const next = mergeAnalysisSnapshot(saved, snap({ filingSuggested: true, filingSuggestion: null }));
    expect(next.filingSuggestion).toBeNull();
  });

  it("keeps a recorded brief failure unless a brief is now present", () => {
    expect(mergeAnalysisSnapshot(entry({ briefFailed: true }), snap()).briefFailed).toBe(true);
    expect(mergeAnalysisSnapshot(entry({ briefFailed: true }), snap({ brief: "b" })).briefFailed).toBe(false);
  });
});
