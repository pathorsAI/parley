import { describe, it, expect, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { buildSummary, saveEntryArgs } from "./entryStore";
import type { HistoryEntry } from "./types";
import { seg } from "../test/fixtures";

const entry = {
  id: "e1",
  title: "T",
  source: "live",
  createdAt: 1,
  durationMs: 2,
  segments: [seg({ text: "hi" })],
  speakerNames: {},
  findings: [],
  actionItems: [],
  meetingContext: "",
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",
  audio: "audio.ogg",
} as HistoryEntry;

describe("saveEntryArgs (the one save_history_entry payload)", () => {
  it("keeps the recording untouched by default", () => {
    expect(saveEntryArgs("e1", entry)).toEqual({
      id: "e1",
      summaryJson: JSON.stringify(buildSummary(entry)),
      metaJson: JSON.stringify(entry),
      audioSourcePath: null,
      compress: false,
    });
  });

  it("carries a new recording and the compress flag, keyed by the given id", () => {
    const args = saveEntryArgs("other", entry, { audioSourcePath: "/a.wav", compress: true });
    expect(Object.keys(args)).toEqual(["id", "summaryJson", "metaJson", "audioSourcePath", "compress"]);
    expect(args.id).toBe("other");
    expect(args.audioSourcePath).toBe("/a.wav");
    expect(args.compress).toBe(true);
  });
});
