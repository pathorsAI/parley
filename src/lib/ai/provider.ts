import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Settings } from "../types";
import { PROVIDER_BY_ID, isReasoningModel } from "./providers";

export { isReasoningModel } from "./providers";

/**
 * Resolve a Vercel AI SDK model for the active provider, driven by the provider
 * registry. `kind` selects the fast Q&A model ("ask") or the stronger
 * evaluation model ("eval").
 *
 * Anthropic is called directly from the webview, so it needs the
 * `anthropic-dangerous-direct-browser-access` header to satisfy CORS — fine for
 * a local desktop app where the key lives in app settings, not a public site.
 */
export function getModel(settings: Settings, kind: "ask" | "eval"): LanguageModel {
  const info = PROVIDER_BY_ID[settings.provider];
  const modelId = settings.models[settings.provider][kind];
  const apiKey = settings[info.apiKeyField];

  if (info.kind === "anthropic") {
    const anthropic = createAnthropic({
      apiKey,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return anthropic(modelId);
  }

  const client = createOpenAICompatible({
    name: info.id,
    baseURL: info.baseURL!,
    apiKey,
  });
  return client.chatModel(modelId);
}

/**
 * Per-call provider options. For OpenAI-compatible reasoning models (Groq /
 * OpenRouter gpt-oss, o-series, etc.) pass the selected `reasoning_effort`.
 * Keyed by the active provider name; empty for non-reasoning models or Anthropic.
 */
export function getProviderOptions(settings: Settings, kind: "ask" | "eval") {
  const info = PROVIDER_BY_ID[settings.provider];
  if (info.kind === "openai-compatible" && isReasoningModel(settings.models[settings.provider][kind])) {
    return { [info.id]: { reasoningEffort: settings.reasoningEffort } };
  }
  return {};
}
