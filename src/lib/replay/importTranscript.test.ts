import { describe, it, expect } from "vitest";
import {
  dateFromFileName,
  estimateSpeechMs,
  parseTranscript,
  titleFromFileName,
} from "./importTranscript";

// ── Real export shapes (matching the Drive corpus this feature targets) ──────

const SPEAKER_FORMAT = `Recording-2026-07-16-12-00

Speaker 1:
Okay. Hello, Danny.

Speaker 2:
哎，我想，呃，你剛有問那個嗎？簡報部分跟demo。

Speaker 1:
嗯，對。

Speaker 2:
OK，那這樣的話，我這邊只有現成的材料。
我就跟之前貼給你一樣。
`;

const TIMESTAMP_FORMAT = `[00:00:00.000] 然後這樣的話可以讓使用者等待體感時間更快但你們是可以被打斷的嗎?
[00:00:07.760] 可以被打斷,剛剛我還沒有戳到他的打斷但之後其實打這個號碼可以玩玩看
[00:09:59.980] 希望說也不要太貴太多錢所以我們遇到這個問題
`;

describe("parseTranscript — speaker-label format", () => {
  const parsed = parseTranscript(SPEAKER_FORMAT)!;

  it("detects the format and keeps every spoken block", () => {
    expect(parsed.format).toBe("speakers");
    expect(parsed.segments).toHaveLength(4);
    expect(parsed.segments[0].text).toBe("Okay. Hello, Danny.");
    // Multi-line block folds into one segment.
    expect(parsed.segments[3].text).toContain("我就跟之前貼給你一樣");
  });

  it("maps labels to diarized speakers and seeds speakerNames", () => {
    expect(parsed.segments.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
    expect(parsed.segments.every((s) => s.source === "them" && s.isFinal)).toBe(true);
    expect(parsed.speakerNames).toEqual({ "them-0": "Speaker 1", "them-1": "Speaker 2" });
  });

  it("synthesizes a contiguous increasing timeline", () => {
    for (let i = 0; i < parsed.segments.length; i++) {
      const s = parsed.segments[i];
      expect(s.endMs).toBeGreaterThan(s.startMs);
      if (i > 0) expect(s.startMs).toBe(parsed.segments[i - 1].endMs);
    }
    expect(parsed.durationMs).toBe(parsed.segments[3].endMs);
  });

  it("lifts the recorder's first line out as an embedded title", () => {
    expect(parsed.embeddedTitle).toBe("Recording-2026-07-16-12-00");
    expect(parsed.segments.some((s) => s.text.includes("Recording-"))).toBe(false);
  });

  it("supports inline labels once they repeat, and fullwidth colons", () => {
    const inline = parseTranscript(
      "Jojo： 這次報價先照舊。\n業務： 好，那交期呢？\nJojo： 下週給你。\n業務： 收到。\n",
    )!;
    expect(inline.format).toBe("speakers");
    expect(inline.segments).toHaveLength(4);
    expect(inline.speakerNames).toEqual({ "them-0": "Jojo", "them-1": "業務" });
  });

  it("does not turn a one-off heading with a colon into a speaker", () => {
    const parsed2 = parseTranscript(
      "Speaker 1:\n我們先對一下結論。\n結論: 下週簽約。\nSpeaker 2:\n沒問題。\n",
    )!;
    expect(Object.values(parsed2.speakerNames)).toEqual(["Speaker 1", "Speaker 2"]);
    // The heading stays inside Speaker 1's block.
    expect(parsed2.segments[0].text).toContain("結論: 下週簽約。");
  });
});

describe("parseTranscript — timestamped format", () => {
  const parsed = parseTranscript(TIMESTAMP_FORMAT)!;

  it("detects the format and uses the real stamps", () => {
    expect(parsed.format).toBe("timestamps");
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[0].startMs).toBe(0);
    expect(parsed.segments[1].startMs).toBe(7760);
    expect(parsed.segments[2].startMs).toBe(599_980);
  });

  it("ends each segment at the next stamp; the last one is estimated", () => {
    expect(parsed.segments[0].endMs).toBe(7760);
    expect(parsed.segments[1].endMs).toBe(599_980);
    expect(parsed.segments[2].endMs).toBeGreaterThan(599_980);
    expect(parsed.durationMs).toBe(parsed.segments[2].endMs);
  });

  it("accepts [MM:SS] stamps too", () => {
    const short = parseTranscript("[00:05] 開始。\n[01:30] 結束。\n")!;
    expect(short.format).toBe("timestamps");
    expect(short.segments[0].startMs).toBe(5000);
    expect(short.segments[1].startMs).toBe(90_000);
  });
});

describe("parseTranscript — plain fallback + empties", () => {
  it("splits unstructured text into paragraph segments", () => {
    const parsed = parseTranscript("第一段的內容。\n\n第二段的內容。\n")!;
    expect(parsed.format).toBe("plain");
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments.every((s) => s.speaker === 0)).toBe(true);
  });

  it("returns null for whitespace-only input", () => {
    expect(parseTranscript("")).toBeNull();
    expect(parseTranscript("  \n\n  \n")).toBeNull();
  });

  it("splits a whole-meeting unbroken run into sentence-boundary chunks", () => {
    const run = Array.from({ length: 40 }, (_, i) => `這是第${i}句話而且講得有點長。`).join("");
    const parsed = parseTranscript(run)!;
    expect(parsed.format).toBe("plain");
    expect(parsed.segments.length).toBeGreaterThan(3);
    // No sentence is torn apart: every segment ends on the terminator.
    for (const s of parsed.segments) expect(s.text.endsWith("。")).toBe(true);
    // Nothing lost.
    expect(parsed.segments.map((s) => s.text).join("")).toBe(run);
  });
});

describe("estimateSpeechMs", () => {
  it("scales with CJK characters and latin words, with a floor", () => {
    expect(estimateSpeechMs("嗯")).toBe(1000); // floor
    expect(estimateSpeechMs("這是一句十個字的測試")).toBe(10 * 270);
    expect(estimateSpeechMs("hello world again")).toBeGreaterThanOrEqual(1000);
  });
});

describe("file-name helpers", () => {
  it("strips export suffixes and the extension for the title", () => {
    expect(titleFromFileName("/a/b/台哥大 Danny 會前會_full_transcript.txt")).toBe(
      "台哥大 Danny 會前會",
    );
    expect(titleFromFileName("台哥大EBG_transcript_with_timestamps.txt")).toBe("台哥大EBG");
    expect(titleFromFileName("Will02.txt")).toBe("Will02");
  });

  it("finds an embedded YYYY-MM-DD date, else null", () => {
    const ms = dateFromFileName("內部討論 Cold Outreach 自動化 2026-07-16_full_transcript.txt")!;
    const d = new Date(ms);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 7, 16]);
    expect(dateFromFileName("台哥大jojo_full_transcript.txt")).toBeNull();
  });
});
