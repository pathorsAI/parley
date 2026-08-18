import type { Settings, SttProviderId } from "../types";
import { PROVIDER_BY_ID } from "../ai/providers";
import { CLOUD_URL, cloudToken } from "../cloud/client";

/**
 * Single source of truth for speech-to-text providers, mirroring the Rust
 * `SttProvider`. `diarization` must match the backend's `supports_diarization`
 * — providers without it can't tell speakers apart, so the mixed mic+system
 * stream would collapse everyone onto one speaker.
 */
export interface SttProviderInfo {
  id: SttProviderId;
  label: string;
  /** Can separate speakers on its own (Soniox / Deepgram). */
  diarization: boolean;
  /**
   * Can transcribe an UPLOADED audio file (the batch "replay" path in
   * `replay.rs`), not just live streaming. Gates the upload button + ingest
   * wizard, and must stay in sync with which providers the `transcribe_file`
   * dispatch actually implements. `true` = an implemented batch adapter whose
   * request/response shape is verified against the vendor's API docs (Soniox,
   * Deepgram, AssemblyAI, OpenAI) or, for hosted Parley, against the cloud's own
   * `/stt/batch` contract. Gemini is the only `false` left — its inline Ogg-Opus
   * support + model naming are unconfirmed and it returns no timestamps or
   * diarization.
   */
  supportsFileUpload: boolean;
  /** Settings field holding this provider's API key. */
  apiKeyField: keyof Settings;
  keyPlaceholder: string;
  /** Brand icon in /public/providers. */
  icon: string;
}

/**
 * OpenAI / Gemini transcription share everything but diarization with their LLM
 * provider (same brand, same API key), so borrow their identity from the single
 * LLM registry instead of duplicating it here.
 */
function fromLlm(id: "openai" | "gemini"): Omit<SttProviderInfo, "diarization" | "supportsFileUpload"> {
  const p = PROVIDER_BY_ID[id];
  return { id, label: p.label, apiKeyField: p.apiKeyField, keyPlaceholder: p.keyPlaceholder, icon: p.icon };
}

export const STT_PROVIDERS: SttProviderInfo[] = [
  { id: "soniox", label: "Soniox", diarization: true, supportsFileUpload: true, apiKeyField: "sonioxApiKey", keyPlaceholder: "…", icon: "/providers/soniox.png" },
  { id: "deepgram", label: "Deepgram", diarization: true, supportsFileUpload: true, apiKeyField: "deepgramApiKey", keyPlaceholder: "…", icon: "/providers/deepgram.png" },
  { id: "assemblyai", label: "AssemblyAI", diarization: false, supportsFileUpload: true, apiKeyField: "assemblyaiApiKey", keyPlaceholder: "…", icon: "/providers/assemblyai.png" },
  { ...fromLlm("openai"), diarization: false, supportsFileUpload: true },
  { ...fromLlm("gemini"), diarization: false, supportsFileUpload: false },
  // Hosted account mode: audio goes through Parley Cloud to Soniox (which
  // diarizes), so no vendor is exposed and no key field is used — auth is the
  // signed-in cloud session (see sttApiKey). Borrows the Parley brand from the
  // LLM registry. The picker only offers it in the cloud build when signed in.
  // Both tenses are hosted: live audio over the `/stt/stream` relay, uploaded
  // recordings over the `/stt/batch` endpoint (see sttRelayUrl / sttBatchUrl).
  {
    id: "parley",
    label: PROVIDER_BY_ID["parley"].label,
    diarization: true,
    supportsFileUpload: true,
    apiKeyField: "parleyApiKey",
    keyPlaceholder: "",
    icon: PROVIDER_BY_ID["parley"].icon,
  },
];

export const STT_BY_ID = Object.fromEntries(STT_PROVIDERS.map((p) => [p.id, p])) as Record<
  SttProviderId,
  SttProviderInfo
>;

/**
 * The credential a given STT provider authenticates with. BYOK providers use
 * their settings key field; the hosted "parley" provider has no key — it rides
 * the signed-in cloud session token (empty when signed out, which gates start).
 */
export function sttApiKey(settings: Settings, id: SttProviderId): string {
  if (id === "parley") return cloudToken() ?? "";
  // Trimmed: a pasted key routinely carries a trailing newline, and the callers
  // that gate on `sttApiKey(...).trim()` would then start a session with the
  // untrimmed value and fail auth at the vendor. Same class of bug as the LLM
  // keys (see ai/provider.ts).
  return ((settings[STT_BY_ID[id].apiKeyField] as string) ?? "").trim();
}

/**
 * The STT relay endpoint for a provider: hosted "parley" streams audio through
 * Parley Cloud (a `wss://` URL, authenticated with the session token from
 * `sttApiKey`), so the vendor key never lives on the client. BYOK providers
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
  return id === "parley"
    ? `${CLOUD_URL.replace(/^http/, "ws")}/stt/stream?feature=${feature}`
    : undefined;
}

/**
 * The BATCH (uploaded recording) endpoint for a provider — the replay path's
 * counterpart to {@link sttRelayUrl}. Hosted "parley" POSTs the audio to Parley
 * Cloud, which drives Soniox's async API with the master key server-side, so the
 * vendor key never lives on the client. BYOK providers address their vendor from
 * the Rust adapter itself and have no batch URL. `transcribe_file` must be passed
 * this alongside the credential from `sttApiKey`, or the hosted arm refuses.
 */
export function sttBatchUrl(id: SttProviderId): string | undefined {
  return id === "parley" ? `${CLOUD_URL}/stt/batch` : undefined;
}
