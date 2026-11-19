import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import type { ShownSuggestion } from "./liveSuggest";
import { ADOPTION_WINDOW_MS, adoptionReport } from "./suggestAdoption";

const shown = (text: string, atMs: number, key = text): ShownSuggestion => ({
  key,
  kind: "question",
  text,
  source: null,
  confidence: 0.8,
  mode: "turn",
  atMs,
});

const line = (source: "me" | "them", text: string, startMs: number): TranscriptSegment => ({
  id: `${source}-${startMs}`,
  source,
  speaker: 0,
  text,
  isFinal: true,
  startMs,
  endMs: startMs + 2_000,
});

const isMe = (s: TranscriptSegment) => s.source === "me";

describe("adoptionReport", () => {
  const q = shown("晚上沒接到的電話一個月大概多少通？", 10_000);

  it("counts a suggestion the user said soon after, in their own words", () => {
    const r = adoptionReport([q], [line("me", "想請問晚上沒接到的電話，一個月大概有多少通呢", 15_000)], isMe);
    expect(r).toMatchObject({ shown: 1, used: 1, rate: 1 });
    expect(r.outcomes[0].saidIn?.startMs).toBe(15_000);
  });

  it("does not count the other side saying it, a line before it appeared, or one too late", () => {
    const text = "晚上沒接到的電話一個月大概多少通";
    const segs = [
      line("them", text, 12_000),
      line("me", text, 9_000),
      line("me", text, 10_000 + ADOPTION_WINDOW_MS + 1),
    ];
    expect(adoptionReport([q], segs, isMe)).toMatchObject({ used: 0, rate: 0 });
  });

  it("does not count an unrelated line", () => {
    expect(adoptionReport([q], [line("me", "好的那我們下週再約", 12_000)], isMe).used).toBe(0);
  });

  it("reports no rate when nothing was shown", () => {
    expect(adoptionReport(undefined, [], isMe)).toEqual({ outcomes: [], shown: 0, used: 0, rate: null });
  });

  it("scores each direction of a lull card on its own", () => {
    const a = { ...shown("現在用的訂房系統", 30_000, "t:a"), mode: "lull" as const };
    const b = { ...shown("夜班人力怎麼排", 30_000, "t:b"), mode: "lull" as const };
    const r = adoptionReport([a, b], [line("me", "對了你們夜班人力是怎麼排的", 33_000)], isMe);
    expect(r).toMatchObject({ shown: 2, used: 1, rate: 0.5 });
    expect(r.outcomes.map((o) => !!o.saidIn)).toEqual([false, true]);
  });
});
