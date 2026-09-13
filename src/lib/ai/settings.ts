import type { LlmWorkload, Settings } from "../types";
import type { TranslationKey } from "../../i18n/messages";
import { PROVIDER_BY_ID, parseHttpUrl } from "./providers";
import { cloudToken } from "../cloud/client";

/**
 * The one thing still standing between the user and a working LLM call.
 *
 * Most providers need exactly one thing (an API key), which is why the gate was
 * called `hasProviderKey` for a long time. The "custom" provider broke that
 * assumption: its key is OPTIONAL, and what it actually needs is a base URL
 * plus a model id that only the operator of the server knows. Telling such a
 * user to "add an API key" sends them looking for something that doesn't exist,
 * so every gate now reports WHICH requirement is missing and the UI names it.
 */
export type ProviderRequirement = "signIn" | "apiKey" | "baseUrl" | "model";

/**
 * What the provider serving `workload` is still missing, or null when it's
 * ready to call.
 */
export function missingProviderRequirement(
  settings: Settings,
  workload: LlmWorkload
): ProviderRequirement | null {
  const provider = settings.llmProviders[workload];
  const info = PROVIDER_BY_ID[provider];
  // Hosted "parley" provider: signed-in (a session token) IS the gate — there's
  // no API key; auth rides as the bearer token.
  if (info.id === "parley") return cloudToken() == null ? "signIn" : null;
  // A user-supplied endpoint ("custom"): the URL must parse as http(s) and the
  // lane must name a model. The key stays optional — plenty of self-hosted
  // servers don't check one.
  if (info.userSuppliedBaseUrl) {
    if (!parseHttpUrl(settings.customBaseUrl ?? "")) return "baseUrl";
    return settings.models[provider]?.[workload]?.trim() ? null : "model";
  }
  // Local providers (Ollama) run without a key.
  if (info.requiresKey === false) return null;
  return settings[info.apiKeyField].trim() ? null : "apiKey";
}

/** Whether the provider serving `workload` is configured well enough to call. */
export function isProviderReady(settings: Settings, workload: LlmWorkload): boolean {
  return missingProviderRequirement(settings, workload) === null;
}

/**
 * Whether the provider serving `workload` has a usable configuration.
 *
 * Historical name, kept because every pre-flight gate in the app calls it. It is
 * an alias of {@link isProviderReady} — "key" is no longer the only thing it
 * can be waiting on.
 */
export function hasProviderKey(settings: Settings, workload: LlmWorkload): boolean {
  return isProviderReady(settings, workload);
}

/**
 * The i18n key a "you haven't set this up yet" gate should show.
 *
 * Every such gate in the app used to say some variant of "add an AI key",
 * which is the right sentence for eight of the nine providers. For a
 * self-hosted endpoint it is the wrong sentence twice over — the key is
 * optional, and the thing that is actually blank is the URL or the model id —
 * so those two cases get their own copy and everything else keeps the surface's
 * own wording via `fallback`.
 *
 * Returns null when nothing is missing (i.e. don't show a gate at all).
 */
export function providerGateKey(
  missing: ProviderRequirement | null,
  fallback: TranslationKey
): TranslationKey | null {
  if (missing === null) return null;
  if (missing === "baseUrl") return "provider.missingBaseUrl";
  if (missing === "model") return "provider.missingModel";
  return fallback;
}
