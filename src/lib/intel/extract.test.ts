import { describe, it, expect, vi } from "vitest";

// Boundaries only: resolveBoard reads the live stage file, and the logger's
// non-Tauri path touches `window`. The helpers under test are pure.
vi.mock("../accounts/currentStage", () => ({ resolveScenarioStageId: vi.fn() }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { transcriptText, intelTranscriptReady } from "./extract";
import { seg } from "../test/fixtures";

const CAP = 8_000;

describe("transcriptText (speaker labels handed to the intel-board prompt)", () => {
  it('labels a "mix" meeting by diarized speaker, never collapsing ME into 對方', () => {
    // Single diarizing session (mic + system audio in one stream): EVERY
    // speaker — the user included — arrives as source "mix". This is the only
    // topology an iOS client can produce, so it must not attribute the user's
    // own words to the counterpart.
    const segs = [
      seg({ id: "a", source: "mix", speaker: 1, text: "我們預算大概三十萬", startMs: 0 }),
      seg({ id: "b", source: "mix", speaker: 2, text: "那導入要多久", startMs: 1000 }),
    ];
    expect(transcriptText(segs, undefined, CAP)).toBe(
      "[Speaker 1] 我們預算大概三十萬\n[Speaker 2] 那導入要多久"
    );
  });

  it("applies user-assigned names to mix speakers", () => {
    const segs = [
      seg({ id: "a", source: "mix", speaker: 1, text: "hi", startMs: 0 }),
      seg({ id: "b", source: "mix", speaker: 2, text: "hello", startMs: 1000 }),
    ];
    expect(transcriptText(segs, { "mix-1": "Jack", "mix-2": "Alice" }, CAP)).toBe(
      "[Jack] hi\n[Alice] hello"
    );
  });

  it("keeps the deterministic me/them labels on split-source meetings", () => {
    const segs = [
      seg({ id: "a", source: "me", speaker: 1, text: "first", startMs: 0 }),
      seg({ id: "b", source: "them", speaker: 1, text: "second", startMs: 1000 }),
    ];
    expect(transcriptText(segs, undefined, CAP)).toBe("[You] first\n[Remote 1] second");
  });

  it("drops interim and blank segments and keeps the tail when over the cap", () => {
    const segs = [
      seg({ id: "a", source: "mix", speaker: 1, text: "x".repeat(50), startMs: 0 }),
      seg({ id: "p", source: "mix", speaker: 2, text: "partial", startMs: 1000, isFinal: false }),
      seg({ id: "e", source: "mix", speaker: 2, text: "   ", startMs: 2000 }),
      seg({ id: "z", source: "mix", speaker: 2, text: "tail", startMs: 3000 }),
    ];
    const out = transcriptText(segs, undefined, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("[Speaker 2] tail")).toBe(true);
    expect(out).not.toContain("partial");
  });
});

describe("intelTranscriptReady", () => {
  it("is false below the minimum and true once enough final speech exists", () => {
    expect(intelTranscriptReady([seg({ source: "mix", text: "短", startMs: 0 })])).toBe(false);
    expect(
      intelTranscriptReady([seg({ source: "mix", text: "x".repeat(40), startMs: 0 })])
    ).toBe(true);
  });

  it("ignores interim segments and anything outside the replay keep-window", () => {
    const segs = [
      seg({ id: "i", source: "mix", text: "y".repeat(60), startMs: 0, endMs: 500, isFinal: false }),
      seg({ id: "t", source: "mix", text: "z".repeat(60), startMs: 1000, endMs: 2000 }),
    ];
    expect(intelTranscriptReady(segs, { startMs: 5000, endMs: 9000 })).toBe(false);
    expect(intelTranscriptReady(segs, { startMs: 0, endMs: 9000 })).toBe(true);
  });
});
