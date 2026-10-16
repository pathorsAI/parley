import type { Settings, SttProviderId } from "../types";
import { CLOUD_URL, cloudToken } from "../cloud/client";
import { LOCAL_STT_API_KEY } from "./localModels";
import { STT_BY_ID } from "./registry";

/**
 * Speech-to-text providers: the registry (see registry.ts, re-exported here so
 * existing imports keep working) plus the resolvers that turn a registry row
 * into what a start command sends — the credential, the model and the hosted
 * endpoints. Every decision reads a registry capability, never a provider id.
 */
export {
  FALLBACK_STT_PROVIDER,
  STT_BY_ID,
  STT_PROVIDERS,
  sttLabel,
  sttRequiresAccount,
  usesCloudSession,
  usesLocalModel,
  type SttCredential,
  type SttProviderInfo,
} from "./registry";

/**
 * The credential a given STT provider authenticates with. BYOK providers use
 * their settings key field; a cloud-session provider ("parley") has no key — it
 * rides the signed-in cloud session token (empty when signed out, which gates
 * start).
 */
export function sttApiKey(settings: Settings, id: SttProviderId): string {
  const info = STT_BY_ID[id];
  if (info.credential === "cloudSession") return cloudToken() ?? "";
  // On-device: no credential. A fixed sentinel keeps every `.trim()` gate
  // uniform; whether the selected model is downloaded is checked separately.
  if (info.credential === "localModel") return LOCAL_STT_API_KEY;
  const field = info.apiKeyField;
  if (!field) return "";
  // Trimmed: a pasted key routinely carries a trailing newline, and the callers
  // that gate on `sttApiKey(...).trim()` would then start a session with the
  // untrimmed value and fail auth at the vendor. Same class of bug as the LLM
  // keys (see ai/provider.ts).
  return ((settings[field] as string) ?? "").trim();
}

/**
 * The model id a start command should run, or null to let the backend use the
 * provider's own default. Only an on-device provider picks one in Settings.
 */
export function sttModel(settings: Settings, id: SttProviderId): string | null {
  return STT_BY_ID[id].credential === "localModel" ? settings.localSttModel : null;
}

/**
 * The STT relay endpoint for a provider: hosted "parley" streams audio to
 * Parley Cloud (a `wss://` URL, authenticated with the session token from
 * `sttApiKey`), so no provider key lives on the client. BYOK providers
 * connect straight to their vendor — no relay. Every streaming start command
 * (meeting AND voice typing) must pass this alongside the key.
 *
 * `feature` is the cloud's billing-attribution tag: the relay only records
 * "meeting" | "voice_typing" | "realtime" (anything else is stored blank), so
 * each start path must name itself. Rust uses the URL verbatim — the query
 * param travels with it.
 */
export function sttRelayUrl(
  id: SttProviderId,
  feature: "meeting" | "voice_typing" | "realtime",
): string | undefined {
  const path = STT_BY_ID[id].relayPath;
  return path ? `${CLOUD_URL.replace(/^http/, "ws")}${path}?feature=${feature}` : undefined;
}

/**
 * The BATCH (uploaded recording) endpoint for a provider — the replay path's
 * counterpart to {@link sttRelayUrl}. Hosted "parley" POSTs the audio to Parley
 * Cloud, which transcribes it server-side, so no provider key lives on the
 * client. BYOK providers address their vendor from
 * the Rust adapter itself and have no batch URL. `transcribe_file` must be passed
 * this alongside the credential from `sttApiKey`, or the hosted arm refuses.
 */
export function sttBatchUrl(id: SttProviderId): string | undefined {
  const path = STT_BY_ID[id].batchPath;
  return path ? `${CLOUD_URL}${path}` : undefined;
}
