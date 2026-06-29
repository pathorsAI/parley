import { describe, it, expect, vi } from "vitest";

// history.ts pulls in `log` (whose Tauri-less path touches `window`); we only
// exercise the pure `buildSummary` here, so stub the side-channel to a no-op.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildSummary } from "./history";
import type { HistoryEntry } from "./types";
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
    expect(s.snippet.length).toBe(91);
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
