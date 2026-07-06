import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Settings } from "../types";
import { PROVIDER_BY_ID, isReasoningModel } from "./providers";
import { cloudToken, CLOUD_URL } from "../cloud/client";
import { CLOUD_ENABLED } from "../flags";

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
  "\n\nReturn your answer strictly as a single JSON object matching the provided schema. " +
  "Use the schema's property names EXACTLY (verbatim) — do not rename, translate, or add top-level keys.";

/**
 * Resolve a Vercel AI SDK model for the active provider, driven by the provider
 * registry. `kind` selects the fast Q&A model ("ask") or the stronger
 * evaluation model ("eval").
 *
 * Anthropic is called directly from the webview, so it needs the
 * `anthropic-dangerous-direct-browser-access` header to satisfy CORS — fine for
 * a local desktop app where the key lives in app settings, not a public site.
 */
export function getModel(
  settings: Settings,
  kind: "ask" | "eval",
  opts?: {
    /**
     * Force `json_object` mode even for providers that advertise json_schema.
     * Some models (notably Groq's gpt-oss family) intermittently 400 with
     * `json_validate_failed` under strict json_schema; the resilient wrapper
     * retries with this so the schema is parsed client-side instead. See
     * {@link generateObjectResilient}.
     */
    forceJsonObject?: boolean;
  }
): LanguageModel {
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

  // Hosted "parley" provider: route to Parley Cloud's OpenAI-compatible endpoint.
  // The Better Auth session token rides as the SDK apiKey → `Authorization:
  // Bearer <token>`; the server forces the real Groq model behind the
  // "parley-fast"/"parley-smart" ids. Guarded by CLOUD_ENABLED so the OSS build's
  // dead-code elimination drops this branch entirely (it ships no cloud account).
  if (CLOUD_ENABLED && info.id === "parley") {
    const token = cloudToken();
    // Without a session the SDK would send an empty `Authorization: Bearer`,
    // which the cloud rejects with no usable body — the stream just yields
    // nothing, so the UI shows "no response" with no explanation. Fail loud with
    // an actionable message instead of that silent no-op.
    if (!token) {
      throw new Error(
        "Parley Cloud sign-in required — sign in from Settings → Account to use the Parley provider",
      );
    }
    const parley = createOpenAICompatible({
      name: info.id,
      baseURL: `${CLOUD_URL}/v1`,
      apiKey: token,
      supportsStructuredOutputs: opts?.forceJsonObject ? false : info.supportsStructuredOutputs ?? false,
    });
    return parley.chatModel(modelId);
  }

  const client = createOpenAICompatible({
    name: info.id,
    baseURL: info.baseURL!,
    // Local Ollama needs no key, but the SDK wants a non-empty string.
    apiKey: apiKey || (info.requiresKey === false ? "ollama" : apiKey),
    // true → response_format json_schema (schema ENFORCED); false → json_object
    // (valid JSON only). Off for Ollama, whose /v1 ignores the json_schema shape.
    supportsStructuredOutputs: opts?.forceJsonObject ? false : info.supportsStructuredOutputs ?? false,
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
  if (info.kind !== "openai-compatible") return {};

  const opts: Record<string, string | { require_parameters: boolean }> = {};
  if (isReasoningModel(settings.models[settings.provider][kind])) {
    opts.reasoningEffort = settings.reasoningEffort[kind];
  }
  // OpenRouter fans one model id out to many upstreams; some ignore
  // response_format, which silently dropped our enforced schema (→ "did not
  // match schema"). Force it to only route to backends that honor the schema.
  if (info.id === "openrouter") {
    opts.provider = { require_parameters: true };
  }

  return Object.keys(opts).length ? { [info.id]: opts } : {};
}
