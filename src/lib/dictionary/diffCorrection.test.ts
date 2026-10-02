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

describe("detectCorrection on CJK terms", () => {
  /** Fixing one character of a name used to learn that one character (名 →
   *  明), which then rewrote every 名 in every later dictation. A known term
   *  covering the edit widens the pair to the whole term. */
  it("widens a one-character fix to the anchoring term", () => {
    expect(detectCorrection("我是王小名", "我是王小明", "我是王小名", ["王小明"])).toEqual({
      from: "王小名",
      to: "王小明",
    });
  });

  it("learns an anchored term even when it is most of a short paste", () => {
    // 2 of 4 characters is over the rewrite ratio; the anchor proves it is a
    // term fix all the same.
    expect(detectCorrection("我是小名", "我是小明", "我是小名", ["小明"])).toEqual({
      from: "小名",
      to: "小明",
    });
  });

  it("prefers the longest anchor that covers the edit", () => {
    const inserted = "明天跟王小名開會討論下一季的規劃";
    const fixed = "明天跟王小明開會討論下一季的規劃";
    expect(detectCorrection(inserted, fixed, inserted, ["小明", "王小明"])).toEqual({
      from: "王小名",
      to: "王小明",
    });
  });

  it("refuses a single CJK character without an anchor", () => {
    expect(detectCorrection("我是小名", "我是小明", "我是小名")).toBeNull();
    const inserted = "明天跟王小名開會討論下一季的規劃";
    const fixed = "明天跟王小明開會討論下一季的規劃";
    expect(detectCorrection(inserted, fixed, inserted)).toBeNull();
  });

  it("refuses a one-character CJK → digit edit", () => {
    const inserted = "這次比賽他拿到第一名真的很厲害";
    const fixed = "這次比賽他拿到第1名真的很厲害";
    expect(detectCorrection(inserted, fixed, inserted)).toBeNull();
  });

  it("ignores an anchor that does not cover the edit", () => {
    const inserted = "王小明說派斯的進度很好";
    const fixed = "王小明說派思的進度很好";
    expect(detectCorrection(inserted, fixed, inserted, ["王小明"])).toBeNull();
  });

  it("does not turn a deletion next to a term into a fix of that term", () => {
    const inserted = "王小明很好的同事們";
    const cut = "王小明好的同事們";
    expect(detectCorrection(inserted, cut, inserted, ["王小明"])).toBeNull();
  });

  it("refuses an anchored pair whose misheard side is one character", () => {
    // Inserting 小 into 明 widens to 明 → 小明, and 明 is what would be
    // rewritten everywhere.
    const inserted = "我跟明一起去吃飯然後回家";
    const fixed = "我跟小明一起去吃飯然後回家";
    expect(detectCorrection(inserted, fixed, inserted, ["小明"])).toBeNull();
  });

  it("still learns the zh → ASCII homophone with anchors on hand", () => {
    const inserted = "今天跟派勒的團隊開會，討論語音輸入";
    const fixed = "今天跟Parley的團隊開會，討論語音輸入";
    expect(detectCorrection(inserted, fixed, inserted, ["Parley", "王小明"])).toEqual({
      from: "派勒",
      to: "Parley",
    });
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

  /** A phrase that contains its own variant used to grow text that was already
   *  right: 派斯科技 → 派斯科技科技. */
  it("leaves a phrase that contains its variant alone, and rewrites a lone variant", () => {
    const entries = [entry("派斯科技", ["派斯"])];
    expect(applyReplacements("派斯科技", entries)).toBe("派斯科技");
    expect(applyReplacements("我在派斯上班", entries)).toBe("我在派斯科技上班");
    expect(applyReplacements("派斯科技和派斯", entries)).toBe("派斯科技和派斯科技");
  });

  it("is idempotent", () => {
    const entries = [entry("派斯科技", ["派斯"]), entry("Parley Cloud", ["parley"])];
    for (const text of ["派斯科技和派斯", "ask parley about Parley Cloud", "parley cloud"]) {
      const once = applyReplacements(text, entries);
      expect(applyReplacements(once, entries)).toBe(once);
    }
  });

  it("matches the containing phrase case-insensitively for an ASCII variant", () => {
    const entries = [entry("Parley Cloud", ["parley"])];
    expect(applyReplacements("parley cloud", entries)).toBe("parley cloud");
    expect(applyReplacements("ask parley today", entries)).toBe("ask Parley Cloud today");
  });

  it("keeps the word boundary next to a masked phrase", () => {
    // "Cloudparley" is one word: the variant must not match inside it just
    // because the phrase beside it was masked.
    const entries = [entry("Parley Cloud", ["parley"])];
    expect(applyReplacements("Parley Cloudparley", entries)).toBe("Parley Cloudparley");
  });

  it("still applies a case-only pair", () => {
    const entries = [entry("Parley", ["parley"])];
    expect(applyReplacements("ask parley later", entries)).toBe("ask Parley later");
  });
});
