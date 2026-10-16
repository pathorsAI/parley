import type { Settings, SttProviderId } from "../types";
import { isTauri } from "../platform";
import { recognitionTerms } from "../dictionary";
import { STT_BY_ID, type SttProviderInfo } from "./registry";
import { sttApiKey, sttBatchUrl, sttModel, sttRelayUrl } from "./providers";
import { checkLocalModelReady } from "./localModels";
import { languageHintsFromSettings } from "./languageHints";
import type { SurfaceBlock } from "./errors";

/**
 * THE start gate for every transcription session — a meeting, a voice-typing
 * dictation, an uploaded recording. It reads the selected provider's registry
 * row, resolves its credential, checks an on-device model is downloaded, and
 * either refuses with a code or hands back everything the start command
 * needs. Each entry point only decides how to show a refusal (a toast, the
 * overlay's code, a thrown Error) and which of the request's fields its
 * command takes.
 */
export type TranscriptionKind = "meeting" | "voiceTyping" | "upload";

/** What the start command is given: resolved once, here. */
export interface TranscriptionRequest {
  provider: SttProviderId;
  info: SttProviderInfo;
  /** The credential as `sttApiKey` resolves it (a vendor key, the cloud
   *  session token, or the on-device sentinel). */
  apiKey: string;
  /** The on-device model id; null = the provider's own default. */
  model: string | null;
  diarization: boolean;
  /** Hosted live relay, tagged with this kind's billing feature; live kinds only. */
  relayUrl: string | undefined;
  /** Hosted batch endpoint; uploads only. */
  batchUrl: string | undefined;
  /** BCP-47 hints from the UI language (empty = auto-detect). */
  languageHints: string[];
  /** Recognition bias: the user's name, company and phrase dictionary. */
  vocabulary: string[];
}

/** The blocks each kind can be refused with: only a meeting tells "sign in"
 *  apart from "no key" (see below). */
export type PrepareBlock<K extends TranscriptionKind> = K extends "meeting"
  ? SurfaceBlock<"meeting">
  : "no-key" | "no-local-model";

export type PrepareResult<K extends TranscriptionKind> =
  | { ok: true; request: TranscriptionRequest }
  | { ok: false; code: PrepareBlock<K> };

/** The IO the gate needs, injectable for tests. */
export interface PrepareDeps {
  /** Running inside the Tauri shell (a backend exists to start). */
  isTauri: () => boolean;
  /** The provider's credential; see `sttApiKey`. */
  apiKey: (settings: Settings, id: SttProviderId) => string;
  /** The on-device model is downloaded and verified; see `checkLocalModelReady`. */
  localModelReady: (modelId: string) => Promise<boolean>;
}

export const defaultPrepareDeps: PrepareDeps = {
  isTauri: () => isTauri(),
  apiKey: (settings, id) => sttApiKey(settings, id),
  localModelReady: (modelId) => checkLocalModelReady(modelId),
};

/**
 * Whether a meeting runs on the real (Rust) capture pipeline: inside Tauri
 * with a usable credential. Otherwise a dev build plays the mock stream — so
 * the meeting controls (stop / pause / cancel) ask this same question to know
 * which of the two they are talking to.
 */
export function meetingUsesRealPipeline(
  settings: Settings,
  deps: Pick<PrepareDeps, "isTauri" | "apiKey"> = defaultPrepareDeps,
): boolean {
  return deps.isTauri() && !!deps.apiKey(settings, settings.transcriptionProvider).trim();
}

/** The credential half of the gate (synchronous). A meeting needs the real
 *  pipeline — without it a cloud-session provider is told to sign in and
 *  anything else has no key, even outside Tauri; the other kinds only need a
 *  non-blank credential (a signed-out hosted user gets "no-key", whose text
 *  names both ways out). */
function credentialBlock<K extends TranscriptionKind>(
  kind: K,
  settings: Settings,
  info: SttProviderInfo,
  apiKey: string,
  deps: PrepareDeps,
): PrepareBlock<K> | null {
  if (kind === "meeting") {
    if (meetingUsesRealPipeline(settings, deps)) return null;
    return (info.credential === "cloudSession" ? "signin" : "no-key") as PrepareBlock<K>;
  }
  return apiKey.trim() ? null : ("no-key" as PrepareBlock<K>);
}

const RELAY_FEATURE = { meeting: "meeting", voiceTyping: "voice_typing", upload: null } as const;

function buildRequest(
  kind: TranscriptionKind,
  settings: Settings,
  info: SttProviderInfo,
  apiKey: string,
): TranscriptionRequest {
  const provider = settings.transcriptionProvider;
  const feature = RELAY_FEATURE[kind];
  return {
    provider,
    info,
    apiKey,
    model: sttModel(settings, provider),
    diarization: info.diarization,
    relayUrl: feature ? sttRelayUrl(provider, feature) : undefined,
    batchUrl: kind === "upload" ? sttBatchUrl(provider) : undefined,
    languageHints: languageHintsFromSettings(settings),
    vocabulary: recognitionTerms(settings),
  };
}

/**
 * Decide whether a `kind` session may start with the current settings.
 *
 * Returns synchronously unless an on-device model has to be checked (one IPC
 * round trip), so a start path can stay free of an `await` when nothing is
 * async: voice typing relies on that, because its restart hand-off must stay
 * ordered behind the new session's state reset. Callers that don't care can
 * simply `await` the result.
 */
export function prepareTranscription<K extends TranscriptionKind>(
  kind: K,
  settings: Settings,
  deps: PrepareDeps = defaultPrepareDeps,
): PrepareResult<K> | Promise<PrepareResult<K>> {
  const info = STT_BY_ID[settings.transcriptionProvider];
  const apiKey = deps.apiKey(settings, settings.transcriptionProvider);
  const blocked = credentialBlock(kind, settings, info, apiKey, deps);
  if (blocked) return { ok: false, code: blocked };
  const ready = (): PrepareResult<K> => ({ ok: true, request: buildRequest(kind, settings, info, apiKey) });
  if (info.credential !== "localModel") return ready();
  return deps.localModelReady(settings.localSttModel).then((ok) =>
    ok ? ready() : { ok: false, code: "no-local-model" as PrepareBlock<K> },
  );
}

/**
 * The upload gate at PICK time (before the file dialog result is routed), and
 * synchronous because the drag-drop door is: the provider must implement batch
 * transcription, and have a credential. The model check waits for
 * `prepareTranscription("upload", …)` when the transcription actually runs.
 */
export function uploadPickBlock(
  settings: Settings,
  deps: Pick<PrepareDeps, "apiKey"> = defaultPrepareDeps,
): SurfaceBlock<"upload"> | null {
  const provider = settings.transcriptionProvider;
  if (!STT_BY_ID[provider].supportsFileUpload) return "no-upload";
  return deps.apiKey(settings, provider).trim() ? null : "no-key";
}
