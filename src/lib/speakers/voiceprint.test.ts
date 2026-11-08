import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { pickVoiceSelf, speakerSpans } from "./voiceprint";
import { resolveSelf } from "./self";

const m = (key: string, similarity: number, speechMs = 30_000) => ({ key, similarity, speechMs });

describe("pickVoiceSelf", () => {
  it("picks the speaker clearly closest to the voiceprint", () => {
    expect(pickVoiceSelf([m("mix-1", 0.21), m("mix-2", 0.71), m("mix-3", 0.3)])).toBe("mix-2");
  });

  it("makes no guess when nobody is close, or two are too close to call", () => {
    expect(pickVoiceSelf([m("mix-1", 0.35), m("mix-2", 0.4)])).toBeNull();
    expect(pickVoiceSelf([m("mix-1", 0.66), m("mix-2", 0.6)])).toBeNull();
  });

  it("ignores a speaker with too little audio to judge", () => {
    expect(pickVoiceSelf([m("mix-1", 0.9, 1500), m("mix-2", 0.62)])).toBe("mix-2");
  });
});

describe("speakerSpans", () => {
  const seg = (speaker: number, startMs: number, endMs: number, text = "話"): TranscriptSegment => ({
    id: `${speaker}-${startMs}`,
    source: "mix",
    speaker,
    text,
    isFinal: true,
    startMs,
    endMs,
  });

  it("groups spoken lines per speaker on the file's clock", () => {
    const out = speakerSpans([seg(1, 0, 1000), seg(2, 1000, 3000), seg(1, 3000, 4000), seg(2, 5000, 6000, " ")], 500);
    expect(out).toEqual([
      { key: "mix-1", spans: [{ startMs: 500, endMs: 1500 }, { startMs: 3500, endMs: 4500 }] },
      { key: "mix-2", spans: [{ startMs: 1500, endMs: 3500 }] },
    ]);
  });

  it("feeds resolveSelf, below a mark", () => {
    const segs = [seg(1, 0, 1000), seg(2, 1000, 3000)];
    expect(resolveSelf(segs, null, undefined, "mix-2")?.origin).toBe("voice");
    expect(resolveSelf(segs, "mix-1", undefined, "mix-2")?.key).toBe("mix-1");
  });
});
