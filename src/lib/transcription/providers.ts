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
   * wizard. Only providers with an implemented AND live-verified batch path are
   * `true` — every listed vendor has a pre-recorded API, but each needs its own
   * Rust batch adapter and a smoke test with a real key before it flips on (see
   * the dispatch in `replay.rs::transcribe_file`). Keep this in sync with which
   * providers that dispatch actually handles.
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
  { id: "deepgram", label: "Deepgram", diarization: true, supportsFileUpload: false, apiKeyField: "deepgramApiKey", keyPlaceholder: "…", icon: "/providers/deepgram.png" },
  { id: "assemblyai", label: "AssemblyAI", diarization: false, supportsFileUpload: false, apiKeyField: "assemblyaiApiKey", keyPlaceholder: "…", icon: "/providers/assemblyai.png" },
  { ...fromLlm("openai"), diarization: false, supportsFileUpload: false },
  { ...fromLlm("gemini"), diarization: false, supportsFileUpload: false },
  // Hosted account mode: audio is relayed through Parley Cloud to Soniox (which
  // diarizes), so no vendor is exposed and no key field is used — auth is the
  // signed-in cloud session (see sttApiKey). Borrows the Parley brand from the
  // LLM registry. The picker only offers it in the cloud build when signed in.
  // File upload needs a cloud batch endpoint (relaying to Soniox async) that
  // isn't wired yet — off until that exists and is verified.
  {
    id: "parley",
    label: PROVIDER_BY_ID["parley"].label,
    diarization: true,
    supportsFileUpload: false,
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
  return (settings[STT_BY_ID[id].apiKeyField] as string) ?? "";
}

/**
 * The STT relay endpoint for a provider: hosted "parley" streams audio through
 * Parley Cloud (a `wss://` URL, authenticated with the session token from
 * `sttApiKey`), so the vendor key never lives on the client. BYOK providers
 * connect straight to their vendor — no relay. Every streaming start command
 * (meeting AND voice typing) must pass this alongside the key.
 */
export function sttRelayUrl(id: SttProviderId): string | undefined {
  return id === "parley" ? `${CLOUD_URL.replace(/^http/, "ws")}/stt/stream` : undefined;
}
