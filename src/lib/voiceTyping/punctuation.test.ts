import { describe, expect, it } from "vitest";
import { BARE_PHRASE_MAX_CHARS, SOFT_SENTENCE_CHARS, softenPausePeriods } from "./punctuation";

/** Ten content characters, so sentence budgets can be counted by eye. */
const A10 = "一二三四五六七八九十";
/** One short of the soft-sentence budget, and exactly at it. */
const A31 = A10.repeat(3) + "一";
const A32 = A10.repeat(3) + "一二";

/** input → expected, each with the reason it is here. */
const CASES: [string, string, string][] = [
  ["我覺得。 這個方案可以。", "我覺得，這個方案可以。", "a pause stop between CJK clauses becomes ，; stray space dropped; final 。 kept"],
  ["好的。", "好的", "a bare short phrase drops its trailing 。"],
  ["好的？", "好的？", "？ is always kept"],
  ["我們明天下午三點在公司開會。", "我們明天下午三點在公司開會。", "over the bare-phrase limit, so the final 。 stays"],
  ["你要來嗎？ 我在門口。", "你要來嗎？我在門口。", "？ kept, the space after it dropped"],
  [`${A31}。 然後我們繼續。`, `${A31}，然後我們繼續。`, "run 31 is under the budget: softened"],
  [`${A32}。 然後我們繼續。`, `${A32}。然後我們繼續。`, "run reached the budget: a real sentence end"],
  [`${A10}。 `.repeat(4) + `${A10}。`, `${A10}，${A10}，${A10}，${A10}。${A10}。`, "the budget carries across softened marks"],
  ["我們用 API。 然後再看。", "我們用 API，然後再看。", "Latin before, Han after"],
  ["I agree。 我們就這樣做。", "I agree，我們就這樣做。", "mixed language"],
  ["這樣可以。 OK 那就這樣。", "這樣可以。OK 那就這樣。", "Latin next: 。 kept, space dropped"],
  ["總共。 3 個人。", "總共。3 個人。", "a digit next: 。 kept"],
  ["版本是 3.5。 對。", "版本是 3.5，對。", "an ASCII decimal is untouched"],
  ["網址是 example.com。 你看一下。", "網址是 example.com，你看一下。", "URL dots are untouched"],
  ["Hello world. This is fine.", "Hello world. This is fine.", "ASCII is never touched"],
  ["嗯。。。 好。", "嗯。。。好。", "a run of 。 (an ellipsis) is never softened"],
  ["他說「好」。 然後走了。", "他說「好」。然後走了。", "a 。 after a closing bracket is kept"],
  ["第一段。\n第二段。", "第一段。\n第二段。", "a 。 before a newline is kept"],
  ["所以， 我們走吧。", "所以，我們走吧。", "the space after ， is dropped"],
  ["收到，謝謝。", "收到，謝謝。", "not a bare phrase: it has a ，"],
  ["我明天到。", "我明天到", "bare phrase"],
  ["OK。", "OK", "bare Latin phrase"],
  ["好的。 ", "好的", "trailing space after the mark dropped, then the bare rule"],
  ["。", "", "a lone 。"],
  ["", "", "empty"],
  ["我覺得。 這樣", "我覺得，這樣", "live overlay: the interim tail is still arriving"],
  ["我覺得。 這樣可以。", "我覺得，這樣可以。", "a no-break space after the mark is absorbed too"],
];

const MARKS = new Set(["。", "，", "、", "；", "：", "？", "！"]);

/** The letters and digits of a text, in order. */
function words(s: string): string {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).join("");
}

describe("softenPausePeriods", () => {
  it("uses the tuned budgets", () => {
    expect(SOFT_SENTENCE_CHARS).toBe(32);
    expect(BARE_PHRASE_MAX_CHARS).toBe(7);
  });

  it.each(CASES)("%j → %j (%s)", (input, expected) => {
    expect(softenPausePeriods(input)).toBe(expected);
  });

  it.each(CASES)("is idempotent on %j", (input) => {
    const once = softenPausePeriods(input);
    expect(softenPausePeriods(once)).toBe(once);
  });

  it.each(CASES)("never edits a word of %j", (input) => {
    expect(words(softenPausePeriods(input))).toBe(words(input));
  });

  it("returns text without full-width marks unchanged", () => {
    const ascii = "Hello world. 3.14 http://a.b/c?d=e!";
    expect(softenPausePeriods(ascii)).toBe(ascii);
  });

  /** The overlay re-runs the pass on every token. Each mark's decision depends
   *  only on what precedes it plus the next character, so a longer transcript
   *  may only change the trailing mark of a shorter one, never earlier text. */
  it.each(CASES)("is prefix-stable on %j", (input) => {
    const chars = Array.from(input);
    const full = softenPausePeriods(input);
    for (let k = 0; k <= chars.length; k++) {
      const partial = Array.from(softenPausePeriods(chars.slice(0, k).join("")));
      if (partial.length > 0 && MARKS.has(partial[partial.length - 1])) partial.pop();
      expect(full.startsWith(partial.join(""))).toBe(true);
    }
  });
});
