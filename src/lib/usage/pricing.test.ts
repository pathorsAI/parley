import { describe, it, expect } from "vitest";
import {
  llmCostUsd,
  hasLlmPrice,
  sttCostUsd,
  type LlmTokenBreakdown,
} from "./pricing";

// Pure cost arithmetic — the single source of truth frozen into each usage
// event. We assert the contract: per-bucket billing, context tiers, cache-rate
// fallbacks, and "never guess a price" for unknown models.

function tokens(over: Partial<LlmTokenBreakdown> = {}): LlmTokenBreakdown {
  return {
    noCacheInput: 0,
    cacheReadInput: 0,
    cacheWriteInput: 0,
    output: 0,
    totalInput: 0,
    ...over,
  };
}

describe("llmCostUsd", () => {
  it("bills each input bucket plus output at its own per-1M rate", () => {
    // claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 (per 1M)
    const t = tokens({
      noCacheInput: 1_000_000,
      cacheReadInput: 1_000_000,
      cacheWriteInput: 1_000_000,
      output: 1_000_000,
      totalInput: 3_000_000,
    });
    // 5 + 0.5 + 6.25 + 25 = 36.75
    expect(llmCostUsd("anthropic", "claude-opus-4-8", t)).toBeCloseTo(36.75, 10);
  });

  it("falls back to the input rate when cacheRead/cacheWrite are unset", () => {
    // qwen-max has only input/output → cache buckets bill at input (1.6)
    const t = tokens({
      cacheReadInput: 1_000_000,
      cacheWriteInput: 1_000_000,
      totalInput: 2_000_000,
    });
    // 1.6 + 1.6 = 3.2
    expect(llmCostUsd("qwen", "qwen-max", t)).toBeCloseTo(3.2, 10);
  });

  it("applies the high-context tier for gemini-2.5-pro above 200k input", () => {
    const lo = tokens({ noCacheInput: 1_000_000, totalInput: 100_000 });
    const hi = tokens({ noCacheInput: 1_000_000, totalInput: 300_000 });
    expect(llmCostUsd("gemini", "gemini-2.5-pro", lo)).toBeCloseTo(1.25, 10);
    expect(llmCostUsd("gemini", "gemini-2.5-pro", hi)).toBeCloseTo(2.5, 10);
  });

  it("applies the high-context tier for gpt-5.5 above 272k input", () => {
    const hi = tokens({ noCacheInput: 1_000_000, totalInput: 300_000 });
    // GPT55_HIGH input = 10
    expect(llmCostUsd("openai", "gpt-5.5", hi)).toBeCloseTo(10, 10);
  });

  it("matches context tiers on the base id for aliased (OpenRouter) model ids", () => {
    const hi = tokens({ noCacheInput: 1_000_000, totalInput: 300_000 });
    // "openai/gpt-5.5" → base "gpt-5.5" → high tier (input 10)
    expect(llmCostUsd("openrouter", "openai/gpt-5.5", hi)).toBeCloseTo(10, 10);
  });

  it("prices OpenRouter Anthropic aliases identically to their native model", () => {
    // OpenRouter ids are pass-through aliases → same rate as the native model.
    const t = tokens({
      noCacheInput: 1_000_000,
      cacheReadInput: 1_000_000,
      output: 1_000_000,
      totalInput: 2_000_000,
    });
    expect(llmCostUsd("openrouter", "anthropic/claude-sonnet-4.6", t)).toBeCloseTo(
      llmCostUsd("anthropic", "claude-sonnet-4-6", t),
      10
    );
    expect(llmCostUsd("openrouter", "anthropic/claude-opus-4.8", t)).toBeCloseTo(
      llmCostUsd("anthropic", "claude-opus-4-8", t),
      10
    );
  });

  it("prices z-ai/glm-5.2 at the z.ai published rate", () => {
    const t = tokens({
      noCacheInput: 1_000_000,
      cacheReadInput: 1_000_000,
      output: 1_000_000,
      totalInput: 2_000_000,
    });
    // input 1.4 + cacheRead 0.26 + output 4.4 = 6.06
    expect(llmCostUsd("openrouter", "z-ai/glm-5.2", t)).toBeCloseTo(6.06, 10);
  });

  it("prices kimi-k2-thinking (native + OpenRouter alias) at the K2-base rate", () => {
    const t = tokens({
      noCacheInput: 1_000_000,
      cacheReadInput: 1_000_000,
      output: 1_000_000,
      totalInput: 2_000_000,
    });
    // input 0.6 + cacheRead 0.15 + output 2.5 = 3.25
    expect(llmCostUsd("kimi", "kimi-k2-thinking", t)).toBeCloseTo(3.25, 10);
    expect(llmCostUsd("openrouter", "moonshotai/kimi-k2-thinking", t)).toBeCloseTo(3.25, 10);
  });

  it("returns 0 for Ollama (local, free) regardless of tokens", () => {
    const t = tokens({ noCacheInput: 5_000_000, output: 5_000_000, totalInput: 5_000_000 });
    expect(llmCostUsd("ollama", "anything", t)).toBe(0);
  });

  it("returns 0 for an unknown model — never guess a price", () => {
    const t = tokens({ noCacheInput: 1_000_000, totalInput: 1_000_000 });
    expect(llmCostUsd("openai", "totally-made-up-model", t)).toBe(0);
  });
});

describe("hasLlmPrice", () => {
  it("is true for a known model and for Ollama, false otherwise", () => {
    expect(hasLlmPrice("anthropic", "claude-opus-4-8")).toBe(true);
    expect(hasLlmPrice("ollama", "whatever")).toBe(true);
    expect(hasLlmPrice("openai", "made-up")).toBe(false);
  });

  it("prices every default model id (no $0/untracked default out of the box)", async () => {
    // Guards against adding a provider default without a matching pricing row
    // (a fresh install would otherwise silently report $0 for its default model).
    const { PROVIDERS } = await import("../ai/providers");
    for (const p of PROVIDERS) {
      if (p.requiresKey === false) continue; // local Ollama is intentionally free
      for (const id of [p.defaults.ask, p.defaults.eval]) {
        expect(hasLlmPrice(p.id, id), `${p.id} default "${id}" must be priced`).toBe(true);
      }
    }
  });
});

describe("sttCostUsd", () => {
  it("converts audio seconds to USD at the provider per-minute rate", () => {
    // soniox: 0.002 / minute → 60s = 0.002
    expect(sttCostUsd("soniox", 60)).toBeCloseTo(0.002, 10);
    // deepgram: 0.0048 / minute → 120s = 0.0096
    expect(sttCostUsd("deepgram", 120)).toBeCloseTo(0.0096, 10);
  });

  it("returns 0 for an unknown STT provider", () => {
    expect(sttCostUsd("mystery", 60)).toBe(0);
  });
});
