import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Settings } from "../types";
import { PROVIDER_BY_ID, isReasoningModel } from "./providers";

export { isReasoningModel } from "./providers";

/**
 * Groq/OpenAI `json_object` response_format — which the AI SDK's `generateObject`
 * uses on openai-compatible providers — REQUIRES the literal word "json" to
 * appear somewhere in the messages, or the request 400s with
 * "'messages' must contain the word 'json'…". Append this to the system prompt of
 * every `generateObject` call. Harmless for providers that use tool mode (e.g.
 * Anthropic), so it's safe to apply unconditionally.
 */
export const JSON_MODE_INSTRUCTION =
  "\n\nReturn your answer strictly as a JSON object matching the provided schema.";

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
    // Local Ollama needs no key, but the SDK wants a non-empty string.
    apiKey: apiKey || (info.requiresKey === false ? "ollama" : apiKey),
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
    return { [info.id]: { reasoningEffort: settings.reasoningEffort[kind] } };
  }
  return {};
}
