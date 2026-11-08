import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { addMicSample, detectSelfFromMic, resolveSelf, speakerRoster, type MicSpan } from "./self";

let n = 0;
function line(source: TranscriptSegment["source"], speaker: number, startS: number, endS: number): TranscriptSegment {
  n += 1;
  return { id: `l${n}`, source, speaker, text: "說了一些話", isFinal: true, startMs: startS * 1000, endMs: endS * 1000 };
}

/** The mic timeline a live meeting would build, sampling every 150 ms. */
function micHeard(ranges: [number, number][]): readonly MicSpan[] {
  let spans: readonly MicSpan[] = [];
  for (let t = 0; t <= 120_000; t += 150) {
    const speaking = ranges.some(([a, b]) => t >= a * 1000 && t <= b * 1000);
    spans = addMicSample(spans, t, speaking);
  }
  return spans;
}

describe("addMicSample", () => {
  it("merges samples of one stretch of speech and splits at a real gap", () => {
    let spans: readonly MicSpan[] = [];
    for (const t of [150, 300, 450]) spans = addMicSample(spans, t, true);
    spans = addMicSample(spans, 600, false);
    spans = addMicSample(spans, 2000, true);
    expect(spans).toEqual([
      [0, 450],
      [1850, 2000],
    ]);
  });

  it("returns the same timeline when the mic heard nothing", () => {
    const spans: readonly MicSpan[] = [[0, 150]];
    expect(addMicSample(spans, 900, false)).toBe(spans);
  });
});

describe("detectSelfFromMic", () => {
  // Speaker 2 talks 0–20 s and 40–60 s, Speaker 1 talks 20–40 s and 60–80 s.
  const call = [line("mix", 2, 0, 20), line("mix", 1, 20, 40), line("mix", 2, 40, 60), line("mix", 1, 60, 80)];

  it("finds the speaker the mic heard in an online call", () => {
    expect(detectSelfFromMic(call, micHeard([[0, 20], [40, 60]]))).toBe("mix-2");
  });

  it("gives no answer in a room where the mic hears everyone", () => {
    expect(detectSelfFromMic(call, micHeard([[0, 80]]))).toBeNull();
  });

  it("gives no answer without a timeline or when the mic stayed quiet", () => {
    expect(detectSelfFromMic(call, undefined)).toBeNull();
    expect(detectSelfFromMic(call, [])).toBeNull();
    expect(detectSelfFromMic(call, micHeard([[100, 101]]))).toBeNull();
  });

  it("ignores a speaker with too little talk to judge", () => {
    const short = [...call, line("mix", 3, 90, 92)];
    expect(detectSelfFromMic(short, micHeard([[0, 20], [40, 60], [90, 92]]))).toBe("mix-2");
  });
});

describe("resolveSelf", () => {
  const call = [line("mix", 1, 0, 20), line("mix", 2, 20, 40)];

  it("prefers the speaker the user marked", () => {
    const self = resolveSelf(call, "mix-1", micHeard([[20, 40]]));
    expect(self?.origin).toBe("marked");
    expect(self?.isSelf({ source: "mix", speaker: 1 })).toBe(true);
    expect(self?.isSelf({ source: "mix", speaker: 2 })).toBe(false);
  });

  it("ignores a mark on a speaker the transcript no longer has", () => {
    expect(resolveSelf(call, "mix-7", undefined)).toBeNull();
  });

  it("takes the mic's own track when the meeting was transcribed in two streams", () => {
    const self = resolveSelf([line("me", 1, 0, 10), line("them", 1, 10, 20)], null, undefined);
    expect(self?.origin).toBe("mic-track");
    expect(self?.isSelf({ source: "me", speaker: 2 })).toBe(true);
    expect(self?.isSelf({ source: "them", speaker: 1 })).toBe(false);
  });

  it("falls back to the mic timeline in a diarized meeting", () => {
    const self = resolveSelf(call, null, micHeard([[20, 40]]));
    expect(self?.origin).toBe("mic-activity");
    expect(self?.key).toBe("mix-2");
  });

  it("is unknown for a diarized meeting nothing points into", () => {
    expect(resolveSelf(call, null, undefined)).toBeNull();
  });
});

describe("speakerRoster", () => {
  const segs = [line("mix", 1, 0, 10), line("mix", 2, 10, 40), line("mix", 3, 40, 45), line("mix", 1, 45, 50)];

  it("lists whoever talked most first when the user is unknown", () => {
    expect(speakerRoster(segs, null).map((r) => [r.key, r.talkMs, r.isSelf])).toEqual([
      ["mix-2", 30_000, false],
      ["mix-1", 15_000, false],
      ["mix-3", 5_000, false],
    ]);
  });

  it("puts the user first, badged, however little they said", () => {
    const self = resolveSelf(segs, "mix-3", undefined);
    expect(speakerRoster(segs, self).map((r) => [r.key, r.isSelf])).toEqual([
      ["mix-3", true],
      ["mix-2", false],
      ["mix-1", false],
    ]);
  });
});
