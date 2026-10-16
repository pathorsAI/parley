import type { Settings, SttProviderId } from "../types";
import { PROVIDER_BY_ID } from "../ai/providers";
import type { TranslationKey } from "../../i18n/messages";

/**
 * The speech-to-text provider registry: one row per provider, mirroring the
 * Rust `SttProvider`. Every capability the app branches on is a field here, so
 * nothing outside this module compares provider ids. Kept dependency-free
 * (types, the LLM registry, nothing that reaches the store or Tauri) so the
 * store and the light secondary windows can import it; the credential and
 * endpoint resolvers that need the cloud session live in `providers.ts`.
 *
 * Adding a provider on the frontend = one row here (plus its key field in
 * `Settings`, its price in usage/pricing.ts and its icon in /public/providers).
 */

/**
 * How a provider authenticates, which is also what the credential UI shows:
 * - `apiKey`: a BYOK key the user pastes into `apiKeyField`;
 * - `cloudSession`: the signed-in Parley Cloud session token (no key field);
 * - `localModel`: on-device — no credential, but the selected model must be
 *   downloaded before anything can start (lib/transcription/localModels.ts).
 */
export type SttCredential = "apiKey" | "cloudSession" | "localModel";

export interface SttProviderInfo {
  id: SttProviderId;
  /** Brand name, shown as-is. A non-brand entry also sets `labelKey`. */
  label: string;
  /** Translated display name for entries that aren't a brand (see sttLabel). */
  labelKey?: TranslationKey;
  /** Can separate speakers on its own (Soniox / Deepgram). Must match the
   *  backend's `supports_diarization` — providers without it can't tell
   *  speakers apart, so the mixed mic+system stream would collapse everyone
   *  onto one speaker. */
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
  /** How it authenticates; see {@link SttCredential}. */
  credential: SttCredential;
  /** Billed to a Parley account: only offered when signed in to the cloud
   *  build, reset to a BYOK default on sign-out, capped per dictation, and
   *  counted against the hosted allowance. */
  requiresAccount: boolean;
  /** Cloud path live audio is relayed to (hosted providers only); BYOK
   *  providers connect straight to their vendor. See `sttRelayUrl`. */
  relayPath?: string;
  /** Cloud path an uploaded recording is POSTed to (hosted providers only);
   *  BYOK providers are addressed by the Rust adapter itself. See `sttBatchUrl`. */
  batchPath?: string;
  /** Settings field holding this provider's API key; `null` for the on-device
   *  "local" provider, which has no key at all (see sttApiKey). */
  apiKeyField: keyof Settings | null;
  keyPlaceholder: string;
  /** Brand icon in /public/providers. */
  icon: string;
}

/**
 * OpenAI / Gemini transcription share everything but diarization with their LLM
 * provider (same brand, same API key), so borrow their identity from the single
 * LLM registry instead of duplicating it here.
 */
function fromLlm(
  id: "openai" | "gemini",
): Pick<SttProviderInfo, "id" | "label" | "apiKeyField" | "keyPlaceholder" | "icon"> {
  const p = PROVIDER_BY_ID[id];
  return { id, label: p.label, apiKeyField: p.apiKeyField, keyPlaceholder: p.keyPlaceholder, icon: p.icon };
}

/** A bring-your-own-key provider: a key in Settings, no account. */
const BYOK = { credential: "apiKey", requiresAccount: false } as const;

export const STT_PROVIDERS: SttProviderInfo[] = [
  { id: "soniox", label: "Soniox", diarization: true, supportsFileUpload: true, ...BYOK, apiKeyField: "sonioxApiKey", keyPlaceholder: "…", icon: "/providers/soniox.png" },
  { id: "deepgram", label: "Deepgram", diarization: true, supportsFileUpload: true, ...BYOK, apiKeyField: "deepgramApiKey", keyPlaceholder: "…", icon: "/providers/deepgram.png" },
  { id: "assemblyai", label: "AssemblyAI", diarization: false, supportsFileUpload: true, ...BYOK, apiKeyField: "assemblyaiApiKey", keyPlaceholder: "…", icon: "/providers/assemblyai.png" },
  { ...fromLlm("openai"), diarization: false, supportsFileUpload: true, ...BYOK },
  { ...fromLlm("gemini"), diarization: false, supportsFileUpload: false, ...BYOK },
  // Hosted account mode: audio goes to Parley Cloud, which transcribes (and
  // diarizes) it, so no key field is used — auth is the signed-in cloud session
  // (see sttApiKey). Borrows the Parley brand from the LLM registry. The picker
  // only offers it in the cloud build when signed in. Both tenses are hosted and
  // speak Parley's own protocol (docs/design/stt-protocol.md): live audio over
  // `/stt/v2/stream`, uploaded recordings over `/stt/batch` (see sttRelayUrl /
  // sttBatchUrl).
  {
    id: "parley",
    label: PROVIDER_BY_ID["parley"].label,
    diarization: true,
    supportsFileUpload: true,
    credential: "cloudSession",
    requiresAccount: true,
    relayPath: "/stt/v2/stream",
    batchPath: "/stt/batch",
    apiKeyField: "parleyApiKey",
    keyPlaceholder: "",
    icon: PROVIDER_BY_ID["parley"].icon,
  },
  // On-device transcription (whisper.cpp): no key, no network after the model
  // download. Which model runs is `settings.localSttModel`; it must be
  // downloaded before anything can start (lib/transcription/localModels.ts).
  // No diarization — whisper only transcribes. The batch arm of
  // `transcribe_file` implements it, so uploads work too.
  {
    id: "local",
    label: "Local (whisper.cpp)",
    labelKey: "stt.local.label",
    diarization: false,
    supportsFileUpload: true,
    credential: "localModel",
    requiresAccount: false,
    apiKeyField: null,
    keyPlaceholder: "",
    icon: "/providers/local.svg",
  },
];

export const STT_BY_ID = Object.fromEntries(STT_PROVIDERS.map((p) => [p.id, p])) as Record<
  SttProviderId,
  SttProviderInfo
>;

/** The BYOK provider a signed-out user falls back to from an account-only one
 *  (and the default for a fresh install). */
export const FALLBACK_STT_PROVIDER: SttProviderId = "soniox";

/** Display name in the UI language: the translated label when the entry has
 *  one, the brand name otherwise. */
export function sttLabel(t: (key: TranslationKey) => string, info: SttProviderInfo): string {
  return info.labelKey ? t(info.labelKey) : info.label;
}

// The capability checks below read the row defensively: a persisted settings
// file can carry an id this build does not know (written by a newer version),
// and an unknown id has no capabilities — the same answer the old
// `id === "local"`-style comparisons gave it.

/** Runs on-device: nothing may start until its model is downloaded. */
export function usesLocalModel(id: SttProviderId): boolean {
  return STT_BY_ID[id]?.credential === "localModel";
}

/** Authenticates with the signed-in cloud session rather than a key. */
export function usesCloudSession(id: SttProviderId): boolean {
  return STT_BY_ID[id]?.credential === "cloudSession";
}

/** Billed to a Parley account; see {@link SttProviderInfo.requiresAccount}. */
export function sttRequiresAccount(id: SttProviderId): boolean {
  return STT_BY_ID[id]?.requiresAccount === true;
}
