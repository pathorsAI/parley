import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Settings } from "../types";

/**
 * Resolve a Vercel AI SDK model for the active provider.
 *
 * `kind` selects the fast Q&A model ("ask") or the stronger evaluation model
 * ("eval"). Both providers are configured here so the UI can switch between
 * Claude (direct) and OpenRouter without touching call sites.
 *
 * Anthropic is called directly from the webview, so it needs the
 * `anthropic-dangerous-direct-browser-access` header to satisfy CORS — fine for
 * a local desktop app where the key lives in app settings, not a public site.
 */
export function getModel(settings: Settings, kind: "ask" | "eval"): LanguageModel {
  const modelId = settings.models[settings.provider][kind];

  if (settings.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: settings.anthropicApiKey,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return anthropic(modelId);
  }

  if (settings.provider === "groq") {
    const groq = createOpenAICompatible({
      name: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: settings.groqApiKey,
    });
    return groq.chatModel(modelId);
  }

  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: settings.openrouterApiKey,
  });
  return openrouter.chatModel(modelId);
}

/**
 * Per-call provider options. For Groq's gpt-oss reasoning models this passes the
 * selected `reasoning_effort`. Keyed by provider name, so it's a no-op for
 * providers other than the active one — safe to spread into every call.
 */
export function getProviderOptions(settings: Settings) {
  return { groq: { reasoningEffort: settings.reasoningEffort } };
}
