import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROTECTED_TERMS,
  MIN_POLISH_CHARS,
  POLISH_SYSTEM_PROMPT,
  acceptPolish,
  canPolish,
  containsSimplifiedChinese,
  polishSystemPrompt,
  shouldPolish,
} from "./polish";
import type { Settings } from "../types";

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

describe("acceptPolish", () => {
  const raw = "所以我覺得這個東西呢就是那個我們應該要先做完再說";

  it("accepts a plausible cleanup", () => {
    expect(acceptPolish(raw, "所以我覺得這個東西，我們應該要先做完再說。")).toBe(true);
  });

  it("rejects an empty answer", () => {
    expect(acceptPolish(raw, "   ")).toBe(false);
    expect(acceptPolish("   ", "anything")).toBe(false);
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
