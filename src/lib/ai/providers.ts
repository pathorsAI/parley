import type { LlmProvider, ProviderModels } from "../types";
import type { TranslationKey } from "../../i18n/messages";

/**
 * Single source of truth for LLM providers. Adding a new provider is one entry
 * here — model resolution (provider.ts), key checks (settings.ts), and the
 * Settings UI all derive from this registry. Kept dependency-free (types only)
 * so it can be imported into light bundles like the Settings window.
 */
/** Tone drives the badge color in the picker; label is the marketing pitch. */
export type ProviderTagTone = "smart" | "fast" | "local" | "value" | "default";
export interface ProviderTag {
  /** i18n key for the marketing pitch (resolved with `t()` in the UI). */
  label: TranslationKey;
  tone: ProviderTagTone;
}

export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  /** i18n key for the short note shown next to the name in the picker. */
  note?: TranslationKey;
  /** A colored pitch badge (e.g. "smartest" / "fastest") shown in the picker. */
  tag?: ProviderTag;
  /** Brand icon in /public/providers. */
  icon: string;
  /** How to talk to it: native Anthropic SDK vs an OpenAI-compatible endpoint. */
  kind: "anthropic" | "openai-compatible";
  /** Base URL for openai-compatible providers. */
  baseURL?: string;
  /** Which Settings field holds this provider's API key. */
  apiKeyField:
    | "anthropicApiKey"
    | "openaiApiKey"
    | "geminiApiKey"
    | "groqApiKey"
    | "qwenApiKey"
    | "kimiApiKey"
    | "ollamaApiKey"
    | "openrouterApiKey"
    | "parleyApiKey";
  keyPlaceholder: string;
  /** False for providers that run locally without an API key (Ollama). */
  requiresKey?: boolean;
  /**
   * Send `response_format: { type: "json_schema", strict }` (OpenAI structured
   * outputs — the schema is ENFORCED) instead of `json_object` (valid JSON only,
   * schema not transmitted). Enable for endpoints that accept the OpenAI
   * json_schema shape; leave off for Ollama (its /v1 ignores/rejects it).
   */
  supportsStructuredOutputs?: boolean;
  /** Curated model choices (the current value is always shown too). */
  models: string[];
  defaults: ProviderModels;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    note: "provider.note.anthropic",
    tag: { label: "provider.tag.smartest", tone: "smart" },
    icon: "/providers/anthropic.png",
    kind: "anthropic",
    apiKeyField: "anthropicApiKey",
    keyPlaceholder: "sk-ant-…",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    defaults: { realtime: "claude-haiku-4-5", deep: "claude-opus-4-8" },
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "provider.note.openai",
    icon: "/providers/openai.png",
    kind: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    apiKeyField: "openaiApiKey",
    keyPlaceholder: "sk-…",
    supportsStructuredOutputs: true,
    models: ["gpt-5.5", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    defaults: { realtime: "gpt-4.1-mini", deep: "gpt-5.5" },
  },
  {
    id: "gemini",
    label: "Gemini",
    note: "provider.note.gemini",
    tag: { label: "provider.tag.longContext", tone: "default" },
    icon: "/providers/gemini.png",
    kind: "openai-compatible",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyField: "geminiApiKey",
    keyPlaceholder: "AIza…",
    supportsStructuredOutputs: true,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaults: { realtime: "gemini-2.5-flash", deep: "gemini-2.5-pro" },
  },
  {
    id: "groq",
    label: "Groq",
    note: "provider.note.groq",
    tag: { label: "provider.tag.fastest", tone: "fast" },
    icon: "/providers/groq.png",
    kind: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyField: "groqApiKey",
    keyPlaceholder: "gsk_…",
    supportsStructuredOutputs: true,
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "meta-llama/llama-4-maverick-17b-128e-instruct"],
    defaults: { realtime: "openai/gpt-oss-20b", deep: "openai/gpt-oss-120b" },
  },
  {
    id: "qwen",
    label: "Qwen",
    note: "provider.note.qwen",
    icon: "/providers/qwen.png",
    kind: "openai-compatible",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyField: "qwenApiKey",
    keyPlaceholder: "sk-…",
    models: ["qwen-max", "qwen-plus", "qwen3-235b-a22b"],
    defaults: { realtime: "qwen-plus", deep: "qwen-max" },
  },
  {
    id: "kimi",
    label: "Kimi",
    note: "provider.note.kimi",
    tag: { label: "provider.tag.longContext", tone: "default" },
    icon: "/providers/kimi.png",
    kind: "openai-compatible",
    baseURL: "https://api.moonshot.ai/v1",
    apiKeyField: "kimiApiKey",
    keyPlaceholder: "sk-…",
    // Moonshot ships new K2 point-releases often; pick the exact current id with
    // the "Custom model" field in Settings if a newer one isn't listed here.
    models: ["kimi-k2-thinking", "kimi-k2-turbo-preview", "kimi-k2-0905-preview"],
    defaults: { realtime: "kimi-k2-turbo-preview", deep: "kimi-k2-thinking" },
  },
  {
    id: "ollama",
    label: "Ollama",
    note: "provider.note.ollama",
    tag: { label: "provider.tag.local", tone: "local" },
    icon: "/providers/ollama.png",
    kind: "openai-compatible",
    baseURL: "http://localhost:11434/v1",
    apiKeyField: "ollamaApiKey",
    keyPlaceholder: "",
    requiresKey: false,
    models: ["qwen3", "llama3.2", "gpt-oss:20b"],
    defaults: { realtime: "llama3.2", deep: "qwen3" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    note: "provider.note.openrouter",
    tag: { label: "provider.tag.multiModel", tone: "value" },
    icon: "/providers/openrouter.png",
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyField: "openrouterApiKey",
    keyPlaceholder: "sk-or-…",
    supportsStructuredOutputs: true,
    models: [
      "openai/gpt-5.5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2-thinking",
      "openai/gpt-oss-120b",
    ],
    defaults: { realtime: "anthropic/claude-haiku-4.5", deep: "openai/gpt-5.5" },
  },
  {
    id: "parley",
    label: "Parley",
    note: "provider.note.parley",
    tag: { label: "provider.tag.hosted", tone: "value" },
    // Parley's own brand mark — the hosted service is Parley's, so it must read
    // as Parley, not as the upstream backend (Groq) it happens to route to.
    icon: "/providers/parley.svg",
    kind: "openai-compatible",
    // Literal so this registry stays dependency-free; provider.ts overrides the
    // baseURL with the live CLOUD_URL at model-build time.
    baseURL: "https://api.parley.tw/v1",
    apiKeyField: "parleyApiKey",
    keyPlaceholder: "",
    requiresKey: false,
    // Mirror Groq (the hosted backend) — it accepts the OpenAI json_schema shape.
    supportsStructuredOutputs: true,
    models: ["parley-fast", "parley-smart"],
    defaults: { realtime: "parley-fast", deep: "parley-smart" },
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
