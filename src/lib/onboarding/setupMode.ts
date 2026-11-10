// Onboarding's two routes, Cloud and Local (`Settings.setupMode`), as pure
// rules: how a saved state that predates the setting gets one, and what each
// route does to the provider choices when the user lands on it.
//
// Cloud means Parley's hosted transcription and AI, with no model choice at
// all. Local means the user's own keys or an on-device model, and Parley's
// hosted models are never offered. So switching route is also a provider
// change: nothing may silently stay hosted on the local route, and the cloud
// route always runs on the hosted pair.

import type { LlmProvider, Settings, SetupMode, SttProviderId } from "../types";
import { PROVIDER_BY_ID } from "../ai/providers";
import { STT_PROVIDERS, usesCloudSession } from "../transcription/registry";

/** The LLM a lane falls back to when the local route takes it off Parley's
 *  hosted model: the same vendor a fresh install starts on (DEFAULT_SETTINGS),
 *  repeated here rather than imported so this module stays dependency-free. */
const LOCAL_LLM_FALLBACK: LlmProvider = "groq";

/** The hosted LLM / STT id. One literal, used by both registries. */
const HOSTED = "parley";

function isSetupMode(v: unknown): v is SetupMode {
  return v === "cloud" || v === "local";
}

/**
 * The route a saved state runs on. Without the cloud edition there is only
 * one. A saved value wins; a state saved before the setting existed derives
 * it once from what it was already doing: on Parley's hosted transcription it
 * was effectively the cloud route, anything else (a key, an on-device model)
 * was local. Existing onboarded users are never sent back through the wizard
 * for it — `onboarded` is untouched.
 */
export function resolveSetupMode(
  saved: Readonly<{ setupMode?: unknown; transcriptionProvider?: SttProviderId }>,
  cloudEnabled: boolean,
): SetupMode {
  if (!cloudEnabled) return "local";
  if (isSetupMode(saved.setupMode)) return saved.setupMode;
  return saved.transcriptionProvider && usesCloudSession(saved.transcriptionProvider) ? "cloud" : "local";
}

/** The route MCP follows: the cloud connector only exists in the cloud edition. */
export function effectiveSetupMode(mode: SetupMode, cloudEnabled: boolean): SetupMode {
  return cloudEnabled ? mode : "local";
}

/** An LLM provider billed to a Parley account (today only "parley"). */
export function isHostedLlm(id: LlmProvider): boolean {
  return PROVIDER_BY_ID[id]?.requiresAccount === true;
}

/** Choosing the cloud route: Parley's hosted transcription and AI, both lanes. */
export function cloudRoutePatch(): Partial<Settings> {
  return {
    setupMode: "cloud",
    transcriptionProvider: HOSTED,
    llmProviders: { realtime: HOSTED, deep: HOSTED },
  };
}

/**
 * Choosing the local route. Whatever was hosted is moved off it — someone who
 * signed in first and then picked Local still has Parley's providers set, and
 * the local route's pickers don't even list them — so transcription goes to
 * the first bring-your-own provider and a hosted LLM lane to the fresh-install
 * default. A choice that was already the user's own is left alone.
 */
export function localRoutePatch(
  settings: Readonly<Pick<Settings, "transcriptionProvider" | "llmProviders">>,
): Partial<Settings> {
  const patch: Partial<Settings> = { setupMode: "local" };
  if (usesCloudSession(settings.transcriptionProvider)) {
    const first = STT_PROVIDERS.find((p) => !usesCloudSession(p.id));
    if (first) patch.transcriptionProvider = first.id;
  }
  const { realtime, deep } = settings.llmProviders;
  if (isHostedLlm(realtime) || isHostedLlm(deep)) {
    patch.llmProviders = {
      realtime: isHostedLlm(realtime) ? LOCAL_LLM_FALLBACK : realtime,
      deep: isHostedLlm(deep) ? LOCAL_LLM_FALLBACK : deep,
    };
  }
  return patch;
}

/** The settings already run on the cloud route's hosted pair. */
export function onHostedProviders(settings: Readonly<Pick<Settings, "transcriptionProvider" | "llmProviders">>): boolean {
  return (
    usesCloudSession(settings.transcriptionProvider) &&
    isHostedLlm(settings.llmProviders.realtime) &&
    isHostedLlm(settings.llmProviders.deep)
  );
}
