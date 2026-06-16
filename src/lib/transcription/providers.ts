import type { Settings, SttProviderId } from "../types";

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
  /** Settings field holding this provider's API key. */
  apiKeyField: keyof Settings;
  keyPlaceholder: string;
  /** Brand icon in /public/providers. */
  icon: string;
}

export const STT_PROVIDERS: SttProviderInfo[] = [
  { id: "soniox", label: "Soniox", diarization: true, apiKeyField: "sonioxApiKey", keyPlaceholder: "…", icon: "/providers/soniox.png" },
  { id: "deepgram", label: "Deepgram", diarization: true, apiKeyField: "deepgramApiKey", keyPlaceholder: "…", icon: "/providers/deepgram.png" },
  { id: "assemblyai", label: "AssemblyAI", diarization: false, apiKeyField: "assemblyaiApiKey", keyPlaceholder: "…", icon: "/providers/assemblyai.png" },
  // OpenAI / Gemini transcription reuse the same key as their LLM provider.
  { id: "openai", label: "OpenAI", diarization: false, apiKeyField: "openaiApiKey", keyPlaceholder: "sk-…", icon: "/providers/openai.png" },
  { id: "gemini", label: "Gemini", diarization: false, apiKeyField: "geminiApiKey", keyPlaceholder: "AIza…", icon: "/providers/gemini.png" },
];

export const STT_BY_ID = Object.fromEntries(STT_PROVIDERS.map((p) => [p.id, p])) as Record<
  SttProviderId,
  SttProviderInfo
>;

/** The API key string for a given STT provider from settings. */
export function sttApiKey(settings: Settings, id: SttProviderId): string {
  return (settings[STT_BY_ID[id].apiKeyField] as string) ?? "";
}
