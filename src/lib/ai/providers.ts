import type { LlmProvider, ProviderModels } from "../types";

/**
 * Single source of truth for LLM providers. Adding a new provider is one entry
 * here — model resolution (provider.ts), key checks (settings.ts), and the
 * Settings UI all derive from this registry. Kept dependency-free (types only)
 * so it can be imported into light bundles like the Settings window.
 */
export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  /** Short tag shown next to the name in the picker. */
  note?: string;
  /** Brand icon in /public/providers. */
  icon: string;
  /** How to talk to it: native Anthropic SDK vs an OpenAI-compatible endpoint. */
  kind: "anthropic" | "openai-compatible";
  /** Base URL for openai-compatible providers. */
  baseURL?: string;
  /** Which Settings field holds this provider's API key. */
  apiKeyField: "anthropicApiKey" | "openrouterApiKey" | "groqApiKey";
  keyPlaceholder: string;
  /** Curated model choices (the current value is always shown too). */
  models: string[];
  defaults: ProviderModels;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    note: "Anthropic 直連",
    icon: "/providers/anthropic.png",
    kind: "anthropic",
    apiKeyField: "anthropicApiKey",
    keyPlaceholder: "sk-ant-…",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    defaults: { ask: "claude-sonnet-4-6", eval: "claude-opus-4-8" },
  },
  {
    id: "groq",
    label: "Groq",
    note: "最快 · gpt-oss",
    icon: "/providers/groq.png",
    kind: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyField: "groqApiKey",
    keyPlaceholder: "gsk_…",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "meta-llama/llama-4-maverick-17b-128e-instruct"],
    defaults: { ask: "openai/gpt-oss-20b", eval: "openai/gpt-oss-120b" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    icon: "/providers/openrouter.png",
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyField: "openrouterApiKey",
    keyPlaceholder: "sk-or-…",
    models: ["openai/gpt-5.5", "openai/gpt-4.1", "anthropic/claude-sonnet-4.5", "openai/gpt-oss-120b"],
    defaults: { ask: "openai/gpt-4.1", eval: "openai/gpt-5.5" },
  },
];

export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<
  LlmProvider,
  ProviderInfo
>;

/** Default per-provider model map, derived from the registry. */
export const DEFAULT_MODELS = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.defaults])
) as Record<LlmProvider, ProviderModels>;

/** Heuristic: does this model id support a `reasoning_effort` control? */
export function isReasoningModel(modelId: string): boolean {
  return /gpt-oss|(^|\/)o[1-4]\b|o3|o4-mini|deepseek-r|reason|qwq/i.test(modelId);
}
