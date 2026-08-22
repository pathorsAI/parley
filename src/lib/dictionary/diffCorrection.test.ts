import { describe, expect, it } from "vitest";
import { detectCorrection } from "./diffCorrection";
import { applyReplacements, type DictionaryEntry } from "./index";

/** A dictionary entry with only the fields the replacement pass reads. */
function entry(phrase: string, variants: string[], createdAt = 0): DictionaryEntry {
  return { id: `${phrase}-${createdAt}`, phrase, variants, createdAt, source: "manual" };
}

describe("detectCorrection", () => {
  it("finds a zh homophone fixed mid-sentence", () => {
    const inserted = "今天跟派勒的團隊開會，討論語音輸入";
    const fixed = "今天跟Parley的團隊開會，討論語音輸入";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "派勒",
      to: "Parley",
    });
  });

  it("expands a partial ASCII overlap out to whole words", () => {
    // "Parle" → "Parley" shares everything but the trailing "y"; without the
    // word-boundary expansion this reads as a bare insertion of "y".
    const inserted = "we should ask Parle about the pricing";
    const fixed = "we should ask Parley about the pricing";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "Parle",
      to: "Parley",
    });
  });

  it("expands a shortened word too (deletion inside a word)", () => {
    const inserted = "we should ask Parleyy about the pricing";
    const fixed = "we should ask Parley about the pricing";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "Parleyy",
      to: "Parley",
    });
  });

  it("handles a correction at the very start of the inserted text", () => {
    const inserted = "Parle is the app we are building today";
    const fixed = "Parley is the app we are building today";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "Parle",
      to: "Parley",
    });
  });

  it("handles a correction at the very end of the inserted text", () => {
    const inserted = "the meeting notes are all in Parle";
    const fixed = "the meeting notes are all in Parley";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "Parle",
      to: "Parley",
    });
  });

  it("sees the edit even when the field held text before and after the paste", () => {
    const inserted = "請把派勒的簡報寄給我";
    const baseline = `早安，${inserted}，謝謝。`;
    const current = baseline.replace("派勒", "Parley");
    expect(detectCorrection(baseline, current, inserted)).toEqual({
      from: "派勒",
      to: "Parley",
    });
  });

  it("does not slice through a surrogate pair", () => {
    const inserted = "🚀派勒真的上線了";
    const fixed = "🚀Parley真的上線了";
    const hit = detectCorrection(inserted, fixed, inserted);
    expect(hit).toEqual({ from: "派勒", to: "Parley" });
    // A UTF-16 diff would have handed back half of the rocket.
    expect([...(hit?.from ?? "")].length).toBe(2);
  });

  it("keeps emoji on both sides of the edit intact", () => {
    const inserted = "🎉 派勒 上線了 🚀";
    const fixed = "🎉 Parley 上線了 🚀";
    expect(detectCorrection(inserted, fixed, inserted)).toEqual({
      from: "派勒",
      to: "Parley",
    });
  });

  it("rejects an unchanged field", () => {
    const inserted = "今天跟派勒的團隊開會";
    expect(detectCorrection(inserted, inserted, inserted)).toBeNull();
  });

  it("rejects a pure insertion at a word boundary", () => {
    const inserted = "the quick fox jumps over the lazy dog";
    const grown = "the quick brown fox jumps over the lazy dog";
    expect(detectCorrection(inserted, grown, inserted)).toBeNull();
  });

  it("rejects a pure deletion", () => {
    const inserted = "the quick brown fox jumps over the lazy dog";
    const cut = "the quick fox jumps over the lazy dog";
    expect(detectCorrection(inserted, cut, inserted)).toBeNull();
  });

  it("rejects a full rewrite", () => {
    const inserted = "今天跟派勒的團隊開會";
    const rewritten = "算了，改天再說吧，這段全部重寫";
    expect(detectCorrection(inserted, rewritten, inserted)).toBeNull();
  });

  it("rejects an edit that replaces too much of what we pasted", () => {
    const inserted = "派勒團隊";
    const fixed = "Parley 團隊";
    // "派勒" is half of a four-character paste — too big a share to be a word fix.
    expect(detectCorrection(inserted, fixed, inserted)).toBeNull();
  });

  it("rejects an edit outside the text we pasted", () => {
    const inserted = "討論語音輸入的細節與時程安排";
    const baseline = `會議紀錄：派勒 ${inserted}`;
    const current = `會議紀錄：Parley ${inserted}`;
    // The user fixed a word they had typed themselves — not ours to learn.
    expect(detectCorrection(baseline, current, inserted)).toBeNull();
  });

  it("rejects a term longer than the cap", () => {
    const long = "abcdefghijklmnopqrstuvwxyz"; // 26 > MAX_TERM_LENGTH
    const inserted = `start ${long} end and some more text to keep the ratio low`;
    const current = inserted.replace(long, "Parley");
    expect(detectCorrection(inserted, current, inserted)).toBeNull();
  });

  it("rejects when the pasted text is a single character", () => {
    expect(detectCorrection("a", "b", "a")).toBeNull();
  });

  it("rejects a whitespace-only change", () => {
    const inserted = "we should ask Parley about the pricing";
    const spaced = "we should ask Parley  about the pricing";
    expect(detectCorrection(inserted, spaced, inserted)).toBeNull();
  });
});

describe("applyReplacements", () => {
  it("replaces a zh variant anywhere in the text (no word boundaries)", () => {
    const entries = [entry("Parley", ["派勒"])];
    expect(applyReplacements("我們用派勒開會", entries)).toBe("我們用Parley開會");
  });

  it("matches ASCII variants case-insensitively", () => {
    const entries = [entry("Parley", ["parlay"])];
    expect(applyReplacements("Ask PARLAY about it", entries)).toBe("Ask Parley about it");
  });

  it("only matches ASCII variants as whole words", () => {
    const entries = [entry("Parley", ["parle"])];
    expect(applyReplacements("the parlement voted; ask parle later", entries)).toBe(
      "the parlement voted; ask Parley later",
    );
  });

  it("applies the longer variant first", () => {
    const entries = [
      entry("Parley", ["parle"], 2),
      entry("Parley Cloud", ["parle cloud"], 1),
    ];
    expect(applyReplacements("we host it on parle cloud", entries)).toBe(
      "we host it on Parley Cloud",
    );
  });

  it("leaves text alone when nothing matches", () => {
    const entries = [entry("Parley", ["派勒"])];
    expect(applyReplacements("nothing to see here", entries)).toBe("nothing to see here");
  });

  it("keeps a $ in the phrase literal", () => {
    const entries = [entry("US$1", ["us dollar one"])];
    expect(applyReplacements("costs us dollar one", entries)).toBe("costs US$1");
  });

  it("is a no-op with an empty dictionary", () => {
    expect(applyReplacements("我們用派勒開會", [])).toBe("我們用派勒開會");
  });
});
