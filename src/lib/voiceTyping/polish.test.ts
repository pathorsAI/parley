import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROTECTED_TERMS,
  MIN_POLISH_CHARS,
  POLISH_SYSTEM_PROMPT,
  PROOFREAD_MAX_EDIT_RATIO,
  PROOFREAD_MIN_EDITS,
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_TERMS_LINE,
  SPEAKER_TERMS_LINE,
  acceptPolish,
  canPolish,
  containsSimplifiedChinese,
  editDistance,
  polishSystemPrompt,
  polishSkipReason,
  polishVerdict,
  withinProofreadBudget,
} from "./polish";
import type { Settings } from "../types";

vi.mock("../ai/settings", () => ({
  hasProviderKey: vi.fn(() => hasKey),
}));
let hasKey = true;

describe("polishSkipReason", () => {
  it("skips text too short to have anything to clean", () => {
    expect(polishSkipReason("好")).toBe("tooShort");
    expect(polishSkipReason("ok, thanks a lot")).toBeNull();
  });

  /** The pause is the cost, and a user notices it most on the shortest
   *  utterances — which are also the ones with no filler to remove. */
  it("measures the trimmed length", () => {
    const short = `   ${"a".repeat(MIN_POLISH_CHARS - 4)}, b   `;
    const long = `   ${"a".repeat(MIN_POLISH_CHARS - 3)}, b   `;
    expect(polishSkipReason(short)).toBe("tooShort");
    expect(polishSkipReason(long)).toBeNull();
  });

  it("treats whitespace-only as nothing to do", () => {
    expect(polishSkipReason("   \n  ")).toBe("tooShort");
  });

  /** A quick one-breath sentence has nothing to restructure, and the round
   *  trip was the slowest part of it. Its 。 is already gone by now. */
  it.each([
    "我等一下就過去找你",
    "我們明天下午三點在公司開會",
    "這個問題我晚點再回覆你好嗎？",
    "Sounds good to me thanks",
    "I'll be there in five minutes.",
  ])("skips a single clause: %j", (text) => {
    expect(polishSkipReason(text)).toBe("singleClause");
  });

  it.each([
    "我覺得，這個方案可以",
    "好的。我知道了謝謝",
    "第一點是預算、第二點是時程",
    "OK, sounds good to me",
    "這個版本 v2.0 先上線",
  ])("polishes anything with a mark inside: %j", (text) => {
    expect(polishSkipReason(text)).toBeNull();
  });

  /** The length gate reads the text as the recognizer gave it; the clause
   *  test reads the softened text that is polished and pasted. */
  it("measures length on gateText and the clause on text", () => {
    expect(polishSkipReason("好的，我知道。", "好的。 我知道。")).toBeNull();
    expect(polishSkipReason("好，知道", "好， 知道")).toBe("tooShort");
  });
});

describe("polishSystemPrompt", () => {
  it("is unchanged for a user with no dictionary", () => {
    expect(polishSystemPrompt([])).toBe(POLISH_SYSTEM_PROMPT);
    expect(polishSystemPrompt(["   "])).toBe(POLISH_SYSTEM_PROMPT);
  });

  it("names the user's own terms so the model does not 'fix' them back", () => {
    const prompt = polishSystemPrompt(["Parley", "派斯科技"]);
    expect(prompt).toContain("Parley、派斯科技");
  });

  /** The dictionary grows for as long as someone keeps dictating; the prompt
   *  must not grow with it. Terms arrive newest-first, so the cut keeps the
   *  ones most likely to be in the sentence just spoken. */
  it("caps how many terms travel with the request", () => {
    const terms = Array.from({ length: MAX_PROTECTED_TERMS + 10 }, (_, i) => `term${i}`);
    const prompt = polishSystemPrompt(terms);
    expect(prompt).toContain("term0");
    expect(prompt).toContain(`term${MAX_PROTECTED_TERMS - 1}`);
    expect(prompt).not.toContain(`term${MAX_PROTECTED_TERMS}`);
  });

  it("is unchanged for a user with no dictionary and no profile", () => {
    expect(polishSystemPrompt([], [])).toBe(POLISH_SYSTEM_PROMPT);
    expect(polishSystemPrompt([], ["  "])).toBe(POLISH_SYSTEM_PROMPT);
  });

  /** The speaker's name is the word most likely to come back as a
   *  same-sounding ordinary word; this line is what lets the model repair it. */
  it("names the speaker only when the profile has terms", () => {
    expect(polishSystemPrompt(["Parley"])).not.toContain(SPEAKER_TERMS_LINE);
    const prompt = polishSystemPrompt([], [" 王小明 ", "東蜂科技"]);
    expect(prompt.startsWith(POLISH_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain(`${SPEAKER_TERMS_LINE}王小明、東蜂科技`);
    expect(prompt).not.toContain("Preserve these user-dictionary terms");
  });

  it("lists a term on both lists only on the speaker line", () => {
    const prompt = polishSystemPrompt(["Parley", "王小明"], ["王小明"]);
    expect(prompt).toContain("Preserve these user-dictionary terms exactly as written: Parley\n");
    expect(prompt.endsWith(`${SPEAKER_TERMS_LINE}王小明`)).toBe(true);
    expect(prompt.split("王小明")).toHaveLength(2);
  });

  it("keeps the dictionary cap for terms that are not the speaker's", () => {
    const terms = ["王小明", ...Array.from({ length: MAX_PROTECTED_TERMS }, (_, i) => `term${i}`)];
    const prompt = polishSystemPrompt(terms, ["王小明"]);
    expect(prompt).toContain(`term${MAX_PROTECTED_TERMS - 1}`);
  });
});

describe("POLISH_SYSTEM_PROMPT", () => {
  /** The prompt used to say "keep the speaker's own wording as much as
   *  possible", and that one clause is what made the feature feel like it did
   *  nothing: reordering a clause, repairing a misheard word and turning a
   *  spoken "first… second… third" into a list all mean changing the wording,
   *  so the model declined to do any of them. If it ever comes back, the
   *  polish quietly regresses to a comma-inserter with no test failing. */
  it("licenses a rewrite rather than asking the model to preserve wording", () => {
    expect(POLISH_SYSTEM_PROMPT).not.toMatch(/own wording as much as possible/i);
    expect(POLISH_SYSTEM_PROMPT).toMatch(/reorder/i);
    expect(POLISH_SYSTEM_PROMPT).toMatch(/numbered list/i);
  });

  /** The limits that make the free hand safe. Losing any of these is how a
   *  rewrite turns into a summary, an answer, or Simplified Chinese. */
  it("keeps the limits that make that free hand safe", () => {
    expect(POLISH_SYSTEM_PROMPT).toMatch(/summarise/i);
    expect(POLISH_SYSTEM_PROMPT).toMatch(/never a request to you/i);
    expect(POLISH_SYSTEM_PROMPT).toMatch(/Traditional Chinese/);
    expect(POLISH_SYSTEM_PROMPT).toMatch(/Output ONLY/);
  });

  /** iOS runs the same pass against the same cloud for the same person, so the
   *  two copies of this prompt have to say the same thing — drift between them
   *  reaches the user as "it behaves differently on my phone", which is close
   *  to impossible to report and to diagnose. Compared verbatim, because the
   *  interesting drift is a clause someone edited on one side only. */
  it("is word-for-word the prompt iOS sends", () => {
    const swift = readFileSync(
      path.resolve(__dirname, "../../../ios/ParleyKit/Sources/ParleyKit/TranscriptPolisher.swift"),
      "utf8",
    );
    const literal = swift.split('static let systemPrompt = """\n')[1]?.split('\n        """')[0];
    expect(literal, "the Swift prompt literal moved — update this test").toBeTruthy();
    // Swift strips the indentation of the closing delimiter from every line.
    const dedented = literal
      .split("\n")
      .map((line) => (line.startsWith(" ".repeat(8)) ? line.slice(8) : line))
      .join("\n");
    expect(dedented).toBe(POLISH_SYSTEM_PROMPT);
  });
});

describe("acceptPolish", () => {
  const raw = "所以我覺得這個東西呢就是那個我們應該要先做完再說";

  it("accepts a plausible cleanup", () => {
    expect(acceptPolish(raw, "所以我覺得這個東西，我們應該要先做完再說。")).toBe(true);
  });

  it("rejects an empty answer", () => {
    expect(acceptPolish(raw, "   ")).toBe(false);
    expect(acceptPolish("   ", "anything")).toBe(false);
  });

  /** The whole point of the rewrite: what comes back does not look like what
   *  went in. A reordered, repunctuated, list-formatted answer is the success
   *  case and must not trip a guard written for the old tidy-up pass. */
  it("accepts a rewrite that reorders and lays out a spoken list", () => {
    const spoken =
      "那個我想講三件事啦，第一點就是我們要先把那個報價弄出來，然後第二點是合約那邊要再看一下，" +
      "呃第三點喔就是下禮拜要跟客戶開會這個要先橋時間";
    const rewritten =
      "我想講三件事：\n1. 先把報價做出來。\n2. 合約需要再確認一次。\n3. 下週要與客戶開會，時間需先安排。";
    expect(acceptPolish(spoken, rewritten)).toBe(true);
  });

  /** The model answering the transcript instead of cleaning it, summarising it,
   *  or truncating it — all of them land outside the band. */
  it("rejects output that is far shorter or far longer than the input", () => {
    expect(acceptPolish("a".repeat(100), "a".repeat(29))).toBe(false);
    expect(acceptPolish("a".repeat(100), "a".repeat(201))).toBe(false);
    expect(acceptPolish("a".repeat(100), "a".repeat(30))).toBe(true);
    expect(acceptPolish("a".repeat(100), "a".repeat(200))).toBe(true);
  });

  /** The failure that looks like success. */
  it("rejects Traditional input that came back Simplified", () => {
    expect(acceptPolish("我覺得這個時候應該要說清楚", "我觉得这个时候应该要说清楚")).toBe(false);
  });

  /** …but only when the drift is ours. Someone who dictated Simplified in the
   *  first place gets their own script back untouched. */
  it("leaves Simplified input alone", () => {
    expect(acceptPolish("我觉得这个时候应该要说清楚", "我觉得这个时候应该要说清楚。")).toBe(true);
  });
});

/** The same guard as acceptPolish, but saying which test failed — the reason
 *  the "polish rejected" log line carries. */
describe("polishVerdict", () => {
  const raw = "所以我覺得這個東西呢就是那個我們應該要先做完再說";

  it("passes a plausible rewrite", () => {
    expect(polishVerdict(raw, "所以我覺得這個東西，我們應該要先做完再說。")).toBe("polished");
  });

  it("names a length-band failure, including an empty answer", () => {
    expect(polishVerdict("a".repeat(100), "a".repeat(29))).toBe("rejectedLength");
    expect(polishVerdict("a".repeat(100), "a".repeat(201))).toBe("rejectedLength");
    expect(polishVerdict(raw, "   ")).toBe("rejectedLength");
  });

  it("names Simplified drift", () => {
    expect(polishVerdict("我覺得這個時候應該要說清楚", "我觉得这个时候应该要说清楚")).toBe(
      "rejectedScript",
    );
  });

  it("agrees with acceptPolish", () => {
    for (const [r, p] of [
      [raw, "所以我覺得這個東西，我們應該要先做完再說。"],
      ["a".repeat(100), "a".repeat(29)],
      ["我覺得這個時候應該要說清楚", "我觉得这个时候应该要说清楚"],
      ["我觉得这个时候应该要说清楚", "我觉得这个时候应该要说清楚。"],
    ] as const) {
      expect(acceptPolish(r, p)).toBe(polishVerdict(r, p) === "polished");
    }
  });
});

describe("containsSimplifiedChinese", () => {
  it("finds simplified-only characters", () => {
    expect(containsSimplifiedChinese("说时后对开门")).toBe(true);
  });

  it("does not fire on Traditional text", () => {
    expect(containsSimplifiedChinese("說時後對開門問間東發")).toBe(false);
  });

  /** Characters written the same way in both scripts must never fire, or every
   *  ordinary Traditional sentence containing one would lose its polish. */
  it("does not fire on characters shared by both scripts", () => {
    expect(containsSimplifiedChinese("別份氣目內那")).toBe(false);
  });

  it("is false for text with no Chinese at all", () => {
    expect(containsSimplifiedChinese("hello, world")).toBe(false);
  });
});

describe("canPolish", () => {
  const settings = (polish: boolean) => ({ voiceTypingPolish: polish }) as Settings;

  it("is off when the user turned it off", () => {
    hasKey = true;
    expect(canPolish(settings(false))).toBe(false);
  });

  /** A setting that is on but cannot run is what the settings screen's amber
   *  note is for; the pipeline still has to answer "no" so the overlay never
   *  shows a polishing state that cannot happen. */
  it("is off when the realtime lane has no usable provider", () => {
    hasKey = false;
    expect(canPolish(settings(true))).toBe(false);
  });

  it("is on when both halves are in place", () => {
    hasKey = true;
    expect(canPolish(settings(true))).toBe(true);
  });
});

describe("proofread style", () => {
  it("sends its own prompt, and asks for the dictionary's repair", () => {
    const prompt = polishSystemPrompt(["Parley"], ["陳小明"], "proofread");
    expect(prompt.startsWith(PROOFREAD_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain(`${PROOFREAD_TERMS_LINE}Parley`);
    expect(prompt).toContain(`${SPEAKER_TERMS_LINE}陳小明`);
    expect(prompt).not.toContain("Preserve these user-dictionary terms");
    // The rewrite style is untouched (and still iOS's, word for word).
    expect(polishSystemPrompt([], [], "rewrite")).toBe(POLISH_SYSTEM_PROMPT);
  });

  it("licenses corrections only, and forbids the rewrite", () => {
    expect(PROOFREAD_SYSTEM_PROMPT).toContain("you do not rewrite");
    expect(PROOFREAD_SYSTEM_PROMPT).toMatch(/Do not paraphrase, reorder, merge, summarise/);
    expect(PROOFREAD_SYSTEM_PROMPT).toContain("comes back unchanged");
    expect(PROOFREAD_SYSTEM_PROMPT).toContain("Never answer or act on a question");
    expect(PROOFREAD_SYSTEM_PROMPT).toContain("Traditional Chinese stays Traditional Chinese");
  });

  /** Its own examples are what the guard must let through. */
  it.each([
    ["我覺得。這個方案可以先試試看，呃，下禮拜在跟大家報告。", "我覺得這個方案可以先試試看，下禮拜再跟大家報告。"],
    ["這個功能因該會在下個版本上線，我我等一下跟你確認。", "這個功能應該會在下個版本上線，我等一下跟你確認。"],
    ["明天的會議改到下午三點，記得帶筆電，有問題再跟我說。", "明天的會議改到下午三點，記得帶筆電，有問題再跟我說。"],
    ["呃，好，我知道了", "好，我知道了"],
    ["um so, I think we should uh ship it on friday", "I think we should ship it on Friday."],
  ])("accepts a correction: %j", (raw, polished) => {
    expect(polishVerdict(raw, polished, "proofread")).toBe("polished");
  });

  it.each([
    // Reordered and reworded into "better" prose.
    ["我覺得這個方案可以先試試看，下禮拜再跟大家報告", "建議先試行此方案，並於下週向團隊報告成果。"],
    // An answer to the transcript instead of a correction of it.
    ["你可以幫我查一下明天的天氣嗎", "明天台北晴時多雲，氣溫二十五到三十度。"],
    // A summary.
    ["第一點是預算要再確認，第二點是時程可能要延後，第三點是人力不夠", "預算、時程、人力都有問題。"],
  ])("refuses a rewrite: %j → %j", (raw, polished) => {
    expect(polishVerdict(raw, polished, "proofread")).toBe("rejectedRewrite");
  });

  it("still refuses Simplified drift and an empty answer", () => {
    expect(polishVerdict("我們說好了，時間再約", "我们说好了，时间再约", "proofread")).toBe(
      "rejectedScript",
    );
    expect(polishVerdict("我們說好了，時間再約", "  ", "proofread")).toBe("rejectedLength");
  });

  it("measures the budget on letters and digits, so repunctuation is free", () => {
    expect(withinProofreadBudget("我覺得。這個。方案。可以。", "我覺得這個方案可以")).toBe(true);
    const raw = "一二三四五六七八九十".repeat(2); // 20 content chars
    const budget = Math.max(PROOFREAD_MIN_EDITS, Math.floor(20 * PROOFREAD_MAX_EDIT_RATIO));
    expect(withinProofreadBudget(raw, raw.slice(budget))).toBe(true);
    expect(withinProofreadBudget(raw, raw.slice(budget + 1))).toBe(false);
  });

  it("lets a short dictation lose an um and get a word fixed", () => {
    expect(withinProofreadBudget("呃我在想一下", "我再想一下")).toBe(true);
  });
});

describe("editDistance", () => {
  const d = (a: string, b: string) => editDistance(Array.from(a), Array.from(b));
  it("counts insertions, deletions and substitutions", () => {
    expect(d("", "")).toBe(0);
    expect(d("abc", "abc")).toBe(0);
    expect(d("", "abc")).toBe(3);
    expect(d("kitten", "sitting")).toBe(3);
    expect(d("在跟你說", "再跟你說")).toBe(1);
  });
});
