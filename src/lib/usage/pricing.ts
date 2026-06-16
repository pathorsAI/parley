/**
 * Pricing tables and cost computation — the single source of truth for cost.
 * Cost is computed at record time and frozen into each usage event, so these
 * numbers only affect NEW events. Prices are USD; researched 2026-06.
 *
 * Caveats (see PRICING_NOTES): some rates are estimates or context-tiered, and
 * STT is billed by audio minute (Gemini/OpenAI/Soniox actually bill per token —
 * the per-minute rate is the published/derived equivalent).
 */

export const PRICING_AS_OF = "2026-06";

interface LlmRate {
  /** USD per 1M (non-cached) input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached-input (prompt-cache READ) tokens. Defaults to `input`. */
  cacheRead?: number;
  /** USD per 1M cache-WRITE (cache-creation) tokens. Defaults to `input`. */
  cacheWrite?: number;
}

/**
 * Keyed by model id (the string used to call the provider). Cross-provider
 * shared ids (e.g. via OpenRouter) carry the same underlying price.
 */
const LLM_PRICING: Record<string, LlmRate> = {
  // Anthropic (cacheWrite = 5-min cache creation = 1.25x input)
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  // Google Gemini (2.5-pro ≤200k tier; >200k handled in llmCostUsd)
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  // Groq
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3, cacheRead: 0.0375 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { input: 0.5, output: 0.77 },
  // Alibaba Qwen (base / non-thinking tier)
  "qwen-max": { input: 1.6, output: 6.4 },
  "qwen-plus": { input: 0.4, output: 1.2 },
  "qwen3-235b-a22b": { input: 0.7, output: 2.8 },
  // Moonshot Kimi
  "kimi-k2-0905-preview": { input: 0.6, output: 2.5, cacheRead: 0.15 },
  "kimi-k2-turbo-preview": { input: 1.2, output: 5, cacheRead: 0.3 },
  "moonshot-v1-128k": { input: 2, output: 5 },
  // OpenRouter (pass-through to the underlying model)
  "openai/gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "openai/gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3 },
};

/** Gemini 2.5 Pro pricing above the 200k-token context tier. */
const GEMINI_PRO_HIGH: LlmRate = { input: 2.5, output: 15, cacheRead: 0.25 };
/** GPT-5.5 pricing above the 272k-token input tier (2x input / 1.5x output). */
const GPT55_HIGH: LlmRate = { input: 10, output: 45, cacheRead: 1, cacheWrite: 10 };

/** Input tokens split into the three billable buckets (from AI SDK usage). */
export interface LlmTokenBreakdown {
  /** Non-cached input tokens (billed at `input`). */
  noCacheInput: number;
  /** Cache-read input tokens (billed at `cacheRead`). */
  cacheReadInput: number;
  /** Cache-write / cache-creation input tokens (billed at `cacheWrite`). */
  cacheWriteInput: number;
  /** Output tokens. */
  output: number;
  /** Total input tokens — only used to pick the context-tier rate. */
  totalInput: number;
}

/**
 * USD cost of one LLM call, billing each input bucket at its own rate. Unknown
 * models (and Ollama) cost 0 — we never guess a price.
 */
export function llmCostUsd(provider: string, model: string, t: LlmTokenBreakdown): number {
  if (provider === "ollama") return 0;
  let rate = LLM_PRICING[model];
  // Match context tiers on the base model id so aliased ids (e.g. OpenRouter's
  // "openai/gpt-5.5") still get the high-context rate.
  const baseModel = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (baseModel === "gemini-2.5-pro" && t.totalInput > 200_000) rate = GEMINI_PRO_HIGH;
  if (baseModel === "gpt-5.5" && t.totalInput > 272_000) rate = GPT55_HIGH;
  if (!rate) return 0;

  const cacheReadRate = rate.cacheRead ?? rate.input;
  const cacheWriteRate = rate.cacheWrite ?? rate.input;
  return (
    (t.noCacheInput * rate.input +
      t.cacheReadInput * cacheReadRate +
      t.cacheWriteInput * cacheWriteRate +
      t.output * rate.output) /
    1_000_000
  );
}

/** Whether we have a price for this model (drives an "untracked" hint in the UI). */
export function hasLlmPrice(provider: string, model: string): boolean {
  return provider === "ollama" || model in LLM_PRICING;
}

/**
 * STT billing, normalized to USD per audio MINUTE. Soniox/OpenAI/Gemini bill per
 * token under the hood; these are the published/derived per-minute equivalents.
 */
const STT_PER_MINUTE: Record<string, number> = {
  soniox: 0.002,
  deepgram: 0.0048,
  assemblyai: 0.0025,
  openai: 0.006,
  gemini: 0.00576,
};

/** USD cost of a transcription session, from audio seconds streamed. */
export function sttCostUsd(provider: string, seconds: number): number {
  const perMin = STT_PER_MINUTE[provider];
  if (perMin == null) return 0;
  return (seconds / 60) * perMin;
}

/** Short, user-facing caveats shown under the dashboard. */
export const PRICING_NOTES =
  "Costs are estimates based on published rates (2026-06). Cached-token discounts are applied; " +
  "Gemini 2.5 Pro >200k context and provider context/thinking tiers may differ. STT is billed " +
  "per audio minute streamed (some providers meter per token).";
