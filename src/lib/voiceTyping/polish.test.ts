import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONCISE_MODEL_ALIAS,
  CONCISE_SYSTEM_PROMPT,
  MAX_POLISH_RATIO,
  MAX_PROTECTED_TERMS,
  MIN_POLISH_CHARS,
  POLISH_SYSTEM_PROMPT,
  acceptPolish,
  canPolish,
  containsSimplifiedChinese,
  minPolishRatio,
  polishModelOverride,
  polishSystemPrompt,
  shouldPolish,
} from "./polish";
import type { LlmProvider, Settings, VoiceTypingPolishStyle } from "../types";

vi.mock("../ai/settings", () => ({
  hasProviderKey: vi.fn(() => hasKey),
}));
let hasKey = true;

describe("shouldPolish", () => {
  it("skips text too short to have anything to clean", () => {
    expect(shouldPolish("好")).toBe(false);
    expect(shouldPolish("ok thanks")).toBe(true);
  });

  /** The pause is the cost, and a user notices it most on the shortest
   *  utterances — which are also the ones with no filler to remove. */
  it("measures the trimmed length", () => {
    expect(shouldPolish(`   ${"a".repeat(MIN_POLISH_CHARS - 1)}   `)).toBe(false);
    expect(shouldPolish(`   ${"a".repeat(MIN_POLISH_CHARS)}   `)).toBe(true);
  });

  it("treats whitespace-only as nothing to do", () => {
    expect(shouldPolish("   \n  ")).toBe(false);
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
  const settings = (style: VoiceTypingPolishStyle) =>
    ({ voiceTypingPolishStyle: style }) as Settings;

  it("is off when the user chose no polish", () => {
    hasKey = true;
    expect(canPolish(settings("off"))).toBe(false);
  });

  /** A setting that is on but cannot run is what the settings screen's amber
   *  note is for; the pipeline still has to answer "no" so the overlay never
   *  shows a polishing state that cannot happen. */
  it("is off when the realtime lane has no usable provider", () => {
    hasKey = false;
    expect(canPolish(settings("tidy"))).toBe(false);
    expect(canPolish(settings("concise"))).toBe(false);
  });

  it("is on for either polishing style when both halves are in place", () => {
    hasKey = true;
    expect(canPolish(settings("tidy"))).toBe(true);
    expect(canPolish(settings("concise"))).toBe(true);
  });
});

describe("concise style", () => {
  const raw = "嗯".repeat(100);

  /** Concise is asked to cut, so it may come back much shorter than tidy may:
   *  down to 0.15× rather than 0.3×. The ceiling does not move. */
  it("accepts a reply shorter than tidy would", () => {
    expect(acceptPolish(raw, "好".repeat(20), "tidy")).toBe(false);
    expect(acceptPolish(raw, "好".repeat(20), "concise")).toBe(true);
  });

  it("holds the 0.15×–2.0× band, both ends inclusive", () => {
    expect(acceptPolish(raw, "好".repeat(15), "concise")).toBe(true);
    expect(acceptPolish(raw, "好".repeat(14), "concise")).toBe(false);
    expect(acceptPolish(raw, "好".repeat(200), "concise")).toBe(true);
    expect(acceptPolish(raw, "好".repeat(201), "concise")).toBe(false);
    expect(acceptPolish(raw, "  ", "concise")).toBe(false);
  });

  it("leaves tidy's band where it was", () => {
    expect(minPolishRatio("tidy")).toBe(0.3);
    expect(minPolishRatio("concise")).toBe(0.15);
    expect(MAX_POLISH_RATIO).toBe(2);
    // The default style is tidy, so existing callers keep the old guard.
    expect(acceptPolish(raw, "好".repeat(29))).toBe(false);
    expect(acceptPolish(raw, "好".repeat(30))).toBe(true);
  });

  it("still rejects Traditional input that came back Simplified", () => {
    expect(
      acceptPolish("我覺得這個時候應該要說清楚，明天再確認", "我觉得这个时候应该要说清楚", "concise"),
    ).toBe(false);
  });

  it("carries the dictionary the same way tidy does", () => {
    expect(polishSystemPrompt([], "concise")).toBe(CONCISE_SYSTEM_PROMPT);
    expect(polishSystemPrompt(["Parley", "派斯科技"], "concise")).toBe(
      `${CONCISE_SYSTEM_PROMPT}\nPreserve these user-dictionary terms exactly as written: Parley、派斯科技`,
    );
    const terms = Array.from({ length: MAX_PROTECTED_TERMS + 10 }, (_, i) => `term${i}`);
    expect(polishSystemPrompt(terms, "concise")).not.toContain(`term${MAX_PROTECTED_TERMS}`);
  });

  /** On Parley Cloud concise asks for its own alias (the worker maps it to the
   *  larger model); anywhere else it runs on the lane's own model, and tidy
   *  never overrides anything. */
  it("asks Parley Cloud for the concise alias and leaves other providers alone", () => {
    const settings = (realtime: LlmProvider) =>
      ({ llmProviders: { realtime, deep: realtime } }) as Settings;
    expect(CONCISE_MODEL_ALIAS).toBe("parley-concise");
    expect(polishModelOverride(settings("parley"), "concise")).toBe("parley-concise");
    expect(polishModelOverride(settings("parley"), "tidy")).toBeUndefined();
    expect(polishModelOverride(settings("groq"), "concise")).toBeUndefined();
    expect(polishModelOverride(settings("anthropic"), "concise")).toBeUndefined();
  });
});

/**
 * Both prompts are pinned by SHA-256, and iOS's `TranscriptPolisherTests`
 * pins the same two hashes. Changing a prompt means changing it on both
 * platforms and updating the hash on both sides — an edit on one side alone
 * fails CI on that side.
 */
describe("prompt parity with iOS", () => {
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

  it("pins the tidy prompt", () => {
    expect(sha256(POLISH_SYSTEM_PROMPT)).toBe(
      "ee2cec9aa0736c6725e83b738989c99a81f7ed901dc4e9b8b9e17c1ae6bb02b5",
    );
  });

  it("pins the concise prompt", () => {
    expect(sha256(CONCISE_SYSTEM_PROMPT)).toBe(
      "9546fed2dfa5029253c6f30f5b6a51a2f27c161e68e1270fb08c55cf11909f35",
    );
  });

  /** Verbatim too, while both live in this monorepo: the hash says THAT they
   *  drifted, the diff says where. */
  it("is word-for-word the concise prompt iOS sends", () => {
    const swift = readFileSync(
      path.resolve(__dirname, "../../../ios/ParleyKit/Sources/ParleyKit/TranscriptPolisher.swift"),
      "utf8",
    );
    const literal = swift
      .split('static let conciseSystemPrompt = """\n')[1]
      ?.split('\n        """')[0];
    expect(literal, "the Swift prompt literal moved — update this test").toBeTruthy();
    const dedented = literal
      .split("\n")
      .map((line) => (line.startsWith(" ".repeat(8)) ? line.slice(8) : line))
      .join("\n");
    expect(dedented).toBe(CONCISE_SYSTEM_PROMPT);
  });
});
