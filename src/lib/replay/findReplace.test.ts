import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  findOccurrences,
  foldSegmentTexts,
  replaceInSegments,
  replaceInText,
} from "./findReplace";
import { seg } from "../test/fixtures";

describe("findOccurrences", () => {
  it("matches case-insensitively, like the find bar's highlight", () => {
    expect(findOccurrences("Parley and parley and PARLEY", "parley")).toEqual([0, 11, 22]);
    expect(countOccurrences("派斯科技和派斯", "派斯")).toBe(2);
  });

  it("does not overlap matches", () => {
    expect(findOccurrences("aaaa", "aa")).toEqual([0, 2]);
  });

  it("finds nothing for an empty query or text", () => {
    expect(findOccurrences("hello", "")).toEqual([]);
    expect(findOccurrences("", "a")).toEqual([]);
  });

  it("keeps offsets right after a character whose lowercase is longer", () => {
    // "İ".toLowerCase() is two code units; indexing into the lowercased string
    // would shift every later match by one.
    const text = "İ Parley";
    expect(findOccurrences(text, "parley")).toEqual([2]);
    expect(replaceInText(text, "parley", "X").text).toBe("İ X");
  });
});

describe("replaceInText", () => {
  it("replaces every occurrence in the line and keeps the rest of it", () => {
    expect(replaceInText("我跟東昇談過，東昇說好", "東昇", "東森")).toEqual({
      text: "我跟東森談過，東森說好",
      count: 2,
    });
  });

  it("replaces case-insensitive hits with the replacement as typed", () => {
    expect(replaceInText("parley, PARLEY", "parley", "Parley")).toEqual({ text: "Parley, Parley", count: 2 });
  });

  it("does not count a hit that already reads as the replacement", () => {
    expect(replaceInText("Parley and parley", "parley", "Parley")).toEqual({ text: "Parley and Parley", count: 1 });
    expect(replaceInText("Parley", "parley", "Parley")).toEqual({ text: "Parley", count: 0 });
  });

  it("handles a replacement that contains the query in one pass", () => {
    expect(replaceInText("派斯 和 派斯", "派斯", "派斯科技")).toEqual({ text: "派斯科技 和 派斯科技", count: 2 });
  });

  it("can delete (empty replacement)", () => {
    expect(replaceInText("um, so um yes", "um ", "")).toEqual({ text: "um, so yes", count: 1 });
  });

  it("treats replacement text literally", () => {
    expect(replaceInText("a b", "b", "$&$1")).toEqual({ text: "a $&$1", count: 1 });
  });
});

describe("replaceInSegments", () => {
  const transcript = [
    seg({ id: "a", text: "Tom met tom" }),
    seg({ id: "b", text: "no match here" }),
    seg({ id: "c", text: "TOM again", startMs: 2000, endMs: 3000 }),
  ];

  it("replaces in every matching line and counts occurrences, not lines", () => {
    const { segments, count } = replaceInSegments(transcript, "tom", "Thom");
    expect(count).toBe(3);
    expect(segments.map((s) => s.text)).toEqual(["Thom met Thom", "no match here", "Thom again"]);
    // Untouched lines keep their identity; edited ones keep everything but text.
    expect(segments[1]).toBe(transcript[1]);
    expect(segments[2]).toEqual({ ...transcript[2], text: "Thom again" });
  });

  it("only touches the given segment in one-segment mode", () => {
    const { segments, count } = replaceInSegments(transcript, "tom", "Thom", { onlySegmentId: "c" });
    expect(count).toBe(1);
    expect(segments.map((s) => s.text)).toEqual(["Tom met tom", "no match here", "Thom again"]);
  });

  it("returns the same array when nothing changes", () => {
    for (const [q, r, opts] of [
      ["", "x", {}],
      ["tom", "tom", {}],
      ["zzz", "x", {}],
      ["tom", "Thom", { onlySegmentId: "b" }],
      ["tom", "Thom", { onlySegmentId: "missing" }],
    ] as const) {
      const out = replaceInSegments(transcript, q, r, opts);
      expect(out.count, `${q} → ${r}`).toBe(0);
      expect(out.segments).toBe(transcript);
    }
  });

  it("is a no-op when every hit already reads as the replacement", () => {
    const lines = [seg({ id: "a", text: "Tom and Tom" })];
    expect(replaceInSegments(lines, "tom", "Tom").segments).toBe(lines);
  });
});

describe("foldSegmentTexts", () => {
  it("moves only text, by id, onto another copy of the transcript", () => {
    // On disk: untimed (0 → 0) and an older speaker label. On screen: estimated
    // timing, and the edited text.
    const disk = [seg({ id: "a", text: "東昇", startMs: 0, endMs: 0, speaker: 1 }), seg({ id: "b", text: "x", startMs: 0, endMs: 0 })];
    const screen = [seg({ id: "a", text: "東森", startMs: 500, endMs: 900, speaker: 2 }), seg({ id: "b", text: "x", startMs: 900, endMs: 1200 })];
    const out = foldSegmentTexts(disk, screen);
    expect(out[0]).toEqual({ ...disk[0], text: "東森" });
    expect(out[1]).toBe(disk[1]);
  });

  it("returns the input itself when no text differs", () => {
    const disk = [seg({ id: "a", text: "same" })];
    expect(foldSegmentTexts(disk, [seg({ id: "a", text: "same", startMs: 5 })])).toBe(disk);
    expect(foldSegmentTexts(disk, [seg({ id: "z", text: "other" })])).toBe(disk);
  });
});
