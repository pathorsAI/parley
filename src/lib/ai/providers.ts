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
    | "openrouterApiKey";
  keyPlaceholder: string;
  /** False for providers that run locally without an API key (Ollama). */
  requiresKey?: boolean;
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
    defaults: { ask: "claude-sonnet-4-6", eval: "claude-opus-4-8" },
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
    models: ["gpt-5.5", "gpt-4.1", "o4-mini"],
    defaults: { ask: "gpt-4.1", eval: "gpt-5.5" },
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
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaults: { ask: "gemini-2.5-flash", eval: "gemini-2.5-pro" },
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
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "meta-llama/llama-4-maverick-17b-128e-instruct"],
    defaults: { ask: "openai/gpt-oss-20b", eval: "openai/gpt-oss-120b" },
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
    defaults: { ask: "qwen-plus", eval: "qwen-max" },
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
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-128k"],
    defaults: { ask: "kimi-k2-turbo-preview", eval: "kimi-k2-0905-preview" },
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
    defaults: { ask: "llama3.2", eval: "qwen3" },
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
