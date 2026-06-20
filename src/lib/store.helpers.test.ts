import { describe, it, expect } from "vitest";
import {
  isTrimmed,
  speakerKey,
  defaultSpeakerLabel,
  speakerLabel,
  transcriptAsText,
  transcriptWithTimestamps,
  formatClock,
} from "./store";
import { seg } from "./test/fixtures";

// These are pure domain functions: contracts over speaker identity, trim-window
// overlap, and transcript formatting. No store, no IO — just inputs → outputs.

describe("isTrimmed (replay keep-window overlap)", () => {
  it("keeps everything when trim is null", () => {
    expect(isTrimmed(seg({ startMs: 0, endMs: 1000 }), null)).toBe(false);
  });

  it("keeps a segment fully inside the window", () => {
    const trim = { startMs: 1000, endMs: 5000 };
    expect(isTrimmed(seg({ startMs: 2000, endMs: 3000 }), trim)).toBe(false);
  });

  it("trims a segment entirely before the window", () => {
    const trim = { startMs: 1000, endMs: 5000 };
    expect(isTrimmed(seg({ startMs: 0, endMs: 999 }), trim)).toBe(true);
  });

  it("trims a segment entirely after the window", () => {
    const trim = { startMs: 1000, endMs: 5000 };
    expect(isTrimmed(seg({ startMs: 5001, endMs: 6000 }), trim)).toBe(true);
  });

  it("KEEPS a turn straddling the start boundary (overlap counts)", () => {
    const trim = { startMs: 1000, endMs: 5000 };
    // ends right at the boundary → still overlaps
    expect(isTrimmed(seg({ startMs: 500, endMs: 1000 }), trim)).toBe(false);
    // spans across the start boundary
    expect(isTrimmed(seg({ startMs: 500, endMs: 1500 }), trim)).toBe(false);
  });

  it("KEEPS a turn straddling the end boundary (overlap counts)", () => {
    const trim = { startMs: 1000, endMs: 5000 };
    // starts right at the boundary → still overlaps
    expect(isTrimmed(seg({ startMs: 5000, endMs: 5500 }), trim)).toBe(false);
    // spans across the end boundary
    expect(isTrimmed(seg({ startMs: 4500, endMs: 5500 }), trim)).toBe(false);
  });
});

describe("speakerKey (stable per-speaker identity)", () => {
  it("combines source and speaker number", () => {
    expect(speakerKey({ source: "them", speaker: 2 })).toBe("them-2");
    expect(speakerKey({ source: "me", speaker: 1 })).toBe("me-1");
    expect(speakerKey({ source: "mix", speaker: 3 })).toBe("mix-3");
  });

  it("treats an unknown (0/falsy) speaker as 0 so it groups consistently", () => {
    expect(speakerKey({ source: "them", speaker: 0 })).toBe("them-0");
  });
});

describe("defaultSpeakerLabel", () => {
  it("labels the primary mic voice as You", () => {
    expect(defaultSpeakerLabel({ source: "me", speaker: 1 })).toBe("You");
    expect(defaultSpeakerLabel({ source: "me", speaker: 0 })).toBe("You");
  });

  it("labels secondary mic voices as numbered Speakers", () => {
    expect(defaultSpeakerLabel({ source: "me", speaker: 2 })).toBe("Speaker 2");
  });

  it("labels remote voices as Them / Remote N", () => {
    expect(defaultSpeakerLabel({ source: "them", speaker: 0 })).toBe("Them");
    expect(defaultSpeakerLabel({ source: "them", speaker: 2 })).toBe("Remote 2");
  });

  it("labels mixed-stream voices purely by diarized number", () => {
    expect(defaultSpeakerLabel({ source: "mix", speaker: 0 })).toBe("Speaker 1");
    expect(defaultSpeakerLabel({ source: "mix", speaker: 3 })).toBe("Speaker 3");
  });
});

describe("speakerLabel (prefers a user-assigned name)", () => {
  it("uses the custom name when one is mapped to the key", () => {
    const names = { "them-1": "Alice" };
    expect(speakerLabel({ source: "them", speaker: 1 }, names)).toBe("Alice");
  });

  it("falls back to the default label when no name is mapped", () => {
    const names = { "them-2": "Bob" };
    expect(speakerLabel({ source: "them", speaker: 1 }, names)).toBe("Them");
  });

  it("falls back to the default label when names is omitted", () => {
    expect(speakerLabel({ source: "me", speaker: 1 })).toBe("You");
  });
});

describe("formatClock", () => {
  it("formats milliseconds as m:ss with zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5_000)).toBe("0:05");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(600_000)).toBe("10:00");
  });

  it("clamps negative offsets to 0:00", () => {
    expect(formatClock(-1000)).toBe("0:00");
  });
});

describe("transcriptAsText", () => {
  it("includes only final non-empty segments, sorted by start time, with labels", () => {
    const segs = [
      seg({ id: "b", source: "them", speaker: 1, text: "second", startMs: 2000 }),
      seg({ id: "a", source: "me", speaker: 1, text: "first", startMs: 1000 }),
      seg({ id: "p", source: "them", speaker: 1, text: "partial", startMs: 3000, isFinal: false }),
      seg({ id: "e", source: "them", speaker: 1, text: "   ", startMs: 4000 }),
    ];
    expect(transcriptAsText(segs)).toBe("[You] first\n[Them] second");
  });

  it("applies custom speaker names", () => {
    const segs = [seg({ id: "a", source: "them", speaker: 1, text: "hi", startMs: 0 })];
    expect(transcriptAsText(segs, { "them-1": "Alice" })).toBe("[Alice] hi");
  });
});

describe("transcriptWithTimestamps", () => {
  it("prefixes each line with its [m:ss] start time", () => {
    const segs = [
      seg({ id: "a", source: "me", speaker: 1, text: "hello", startMs: 5_000 }),
      seg({ id: "b", source: "them", speaker: 1, text: "world", startMs: 65_000 }),
    ];
    expect(transcriptWithTimestamps(segs)).toBe("[0:05] [You] hello\n[1:05] [Them] world");
  });
});
