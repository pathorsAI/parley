// Recording upload + batch transcription.
//
// Lets the user pick an audio file, sends it through the selected provider's
// batch transcription API (diarized where the provider supports it, with
// word/segment timestamps), and returns a `ReplaySession` the replay UI can play
// and scrub. Which providers are eligible is gated by `supportsFileUpload` in the
// STT registry — the backend dispatch (`replay.rs::transcribe_file`) must
// implement each one before its flag flips on. Today every provider but Gemini
// qualifies, including hosted Parley Cloud, which batch-transcribes through its
// own endpoint (`sttBatchUrl`) on the signed-in session rather than an API key.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Settings, TranscriptSegment } from "../types";
import { useStore } from "../store";
import type { ReplaySession } from "./types";
import type { SttProviderInfo } from "../transcription/providers";
import { STT_BY_ID, sttApiKey, sttBatchUrl } from "../transcription/providers";
import { normalizeTranscriptText } from "../textNormalize";
import { languageHintsFromSettings } from "../transcription/languageHints";
import { vocabularyTerms } from "../dictionary";
import { log } from "../log";
import { recordUsage } from "../usage/log";
import { sttCostUsd } from "../usage/pricing";

/** Coarse progress stages surfaced to the UI while a recording is ingested. */
export type IngestStage = "decoding" | "uploading" | "transcribing";

export interface IngestProgress {
  stage: IngestStage;
}

export interface IngestOptions {
  /** Called as the ingest moves through its stages. */
  onProgress?: (p: IngestProgress) => void;
}

/** Audio extensions offered in the native file picker. */
const AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "wav",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "wma",
  "webm",
  "mp4",
];

/** Plain-text transcript extensions (issue #130's text-ingest path). */
const TRANSCRIPT_EXTENSIONS = ["txt"];

/** Whether a picked/dropped path is a text transcript rather than audio. */
export function isTranscriptPath(path: string): boolean {
  return /\.txt$/i.test(path);
}

const AUDIO_RE = new RegExp(String.raw`\.(${AUDIO_EXTENSIONS.join("|")})$`, "i");

/** Whether a picked/dropped path is an audio recording we can transcribe. */
export function isAudioPath(path: string): boolean {
  return AUDIO_RE.test(path);
}

/** Shape returned by the Rust `transcribe_file` command (serde camelCase). */
interface RustSegment {
  id: string;
  speaker: number;
  text: string;
  startMs: number;
  endMs: number;
}
interface RustTranscriptionResult {
  segments: RustSegment[];
  durationMs: number;
  /** True when served from the on-disk cache (no provider call → don't bill it). */
  cached: boolean;
  /** Acoustically measured articulation rate (syllables/sec); 0 if unmeasurable. */
  speechRateHz: number;
}

/**
 * How to obtain the credential this provider is missing. Hosted Parley has no
 * key field at all — it rides the signed-in cloud session — so the BYOK wording
 * would send the user hunting in Settings for a box that doesn't exist. Shared
 * by the upload gate and {@link transcribeRecording}, which check the same thing
 * at two different moments (before the picker, and again at invoke time).
 */
function missingCredentialMessage(info: SttProviderInfo): string {
  return info.id === "parley"
    ? "Sign in to Parley Cloud in Settings to transcribe recordings."
    : `Add your ${info.label} API key in Settings to transcribe recordings.`;
}

/** Throw (with the actionable message) unless the configured STT provider can
 *  batch-transcribe an uploaded file. Only audio needs this — text transcripts
 *  import without any provider. Exported for the unit test that pins both
 *  refusal messages. */
export function assertUploadTranscribable(settings: Settings): void {
  const provider = settings.transcriptionProvider;
  const info = STT_BY_ID[provider];
  if (!info.supportsFileUpload) {
    log.warn("ingest: rejected, provider has no file-upload support", { provider });
    // Naming a specific replacement would go stale the moment the registry
    // changes (it already did once); every other provider handles uploads today.
    throw new Error(
      `Uploading a recording isn't supported for ${info.label} yet — switch to another transcription provider in Settings.`,
    );
  }
  if (!sttApiKey(settings, provider).trim()) {
    log.warn("ingest: missing stt credential", { provider });
    throw new Error(missingCredentialMessage(info));
  }
}

/** What the combined History "+ Import" picker resolved to: one audio file for
 *  the transcribe wizard, or text transcript(s) for the direct import dialog. */
export type ImportPick =
  | { kind: "audio"; path: string }
  | { kind: "transcript"; paths: string[] };

/**
 * The one audio-vs-transcript arbitration rule, shared by the picker
 * ({@link pickImportFiles}) and the window drag-drop ({@link importDroppedPaths})
 * so it literally cannot drift: audio wins when the set mixes kinds (a
 * transcription run takes one file), an only-.txt set imports ALL of them, and
 * anything else is ignored.
 */
export function arbitrateImportPaths(paths: string[]): ImportPick | null {
  const audio = paths.find(isAudioPath);
  if (audio) return { kind: "audio", path: audio };
  const transcripts = paths.filter(isTranscriptPath);
  return transcripts.length ? { kind: "transcript", paths: transcripts } : null;
}

/**
 * THE import entry point (R7): every "import a recording" affordance — Home,
 * the library header, a folder, the coach-feed empty state — runs this one
 * flow, so the accepted formats and the audio-vs-transcript arbitration can
 * never drift between doors. Doors differ only in prefill: a folder passes its
 * `folderId` so the resulting entry is filed there. Throws the STT-gate errors
 * from {@link pickImportFiles} — callers toast them.
 */
export async function startImportFlow(
  opts: { folderId?: string | null } = {},
): Promise<void> {
  const pick = await pickImportFiles(useStore.getState().settings);
  if (!pick) return;
  routeImportPick(pick, opts.folderId ?? null);
}

/**
 * The drag-drop door (no picker): same arbitration + STT gate as every picker
 * door. Throws the same errors as {@link pickImportFiles}; callers toast them.
 */
export function importDroppedPaths(paths: string[]): void {
  const pick = arbitrateImportPaths(paths);
  if (!pick) return;
  if (pick.kind === "audio") assertUploadTranscribable(useStore.getState().settings);
  routeImportPick(pick, null);
}

/** Open the right dialog for an arbitrated pick. `folderId` pre-picks the
 *  destination: audio through the meeting folder (the wizard's save snapshots
 *  it via resolveMeetingSave), transcripts by riding on the import dialog. A
 *  null folderId leaves the current pick alone rather than clearing it — both
 *  dialogs SHOW the folder they are about to file into, so an inherited pick is
 *  on screen and one click from being changed. */
function routeImportPick(pick: ImportPick, folderId: string | null): void {
  const { openIngestWizard, openTranscriptImport, setMeetingFolder } = useStore.getState();
  if (pick.kind === "audio") {
    if (folderId) setMeetingFolder(folderId);
    openIngestWizard(pick.path);
  } else {
    openTranscriptImport(pick.paths, folderId);
  }
}

/**
 * One picker for both import flavors — audio recordings AND .txt transcripts
 * (multi-select; a folder's worth of transcripts imports in one go). The STT
 * gate runs only when audio was actually chosen, so transcript import works
 * with any provider and no STT key.
 */
export async function pickImportFiles(settings: Settings): Promise<ImportPick | null> {
  const selected = await open({
    multiple: true,
    directory: false,
    title: "Choose recordings or transcripts",
    filters: [
      { name: "Recording or transcript", extensions: [...AUDIO_EXTENSIONS, ...TRANSCRIPT_EXTENSIONS] },
      { name: "Audio", extensions: AUDIO_EXTENSIONS },
      { name: "Transcript", extensions: TRANSCRIPT_EXTENSIONS },
    ],
  });
  if (selected === null) return null; // user cancelled
  const pick = arbitrateImportPaths(
    (Array.isArray(selected) ? selected : [selected]).filter(Boolean),
  );
  if (pick?.kind === "audio") assertUploadTranscribable(settings);
  return pick;
}

/**
 * Transcribe an already-picked recording into a `ReplaySession` (batch
 * transcription via the configured provider, diarized where it supports it).
 * Reports decoding/uploading/transcribing stages.
 */
export async function transcribeRecording(
  settings: Settings,
  audioPath: string,
  opts: IngestOptions = {},
): Promise<ReplaySession> {
  const provider = settings.transcriptionProvider;
  const info = STT_BY_ID[provider];
  const apiKey = sttApiKey(settings, provider).trim();
  if (!apiKey) {
    throw new Error(missingCredentialMessage(info));
  }

  const name = fileNameOf(audioPath);
  log.info("ingest: file selected", { name });

  reportStage(opts, { stage: "decoding" });

  // Language hints come from settings if present; empty lets Soniox auto-detect.
  const languageHints = languageHintsFromSettings(settings);

  reportStage(opts, { stage: "uploading" });

  // The Rust command uploads the file, creates the async job, polls to
  // completion, then fetches the diarized tokens. It owns the network + secrets.
  // `batchUrl` is set only for hosted Parley, where `apiKey` is the cloud session
  // token and the cloud — not this client — knows the vendor.
  reportStage(opts, { stage: "transcribing" });
  log.info("ingest: transcribe invoke", { provider, languageHints, diarization: info.diarization });
  const result = await invoke<RustTranscriptionResult>("transcribe_file", {
    path: audioPath,
    provider,
    apiKey,
    model: null,
    languageHints,
    // The user's phrase dictionary, as recognition bias — the same terms voice
    // typing feeds the live session.
    vocabulary: vocabularyTerms(),
    diarization: info.diarization,
    batchUrl: sttBatchUrl(provider) ?? null,
  });
  log.info("ingest: transcription ok", {
    segments: result.segments.length,
    durationMs: result.durationMs,
    cached: result.cached,
  });

  // Soniox returns Simplified for zh audio; convert to Traditional to match the
  // live transcription path (tauriEvents.ts also normalizes segments), and apply
  // the phrase dictionary so known variants read the same everywhere.
  const segments: TranscriptSegment[] = await Promise.all(
    result.segments.map(async (s) => ({
      id: s.id,
      source: "them" as const,
      speaker: s.speaker,
      text: await normalizeTranscriptText(s.text),
      isFinal: true,
      startMs: s.startMs,
      endMs: s.endMs,
    }))
  );

  const durationMs =
    result.durationMs ||
    segments.reduce((max, s) => Math.max(max, s.endMs), 0);

  // Bill the audio transcription — but only when it actually hit the provider. A
  // cache hit cost nothing, so recording it would over-count. (LLM costs for evals
  // etc. are billed separately via recordLlmUsage.)
  if (!result.cached && durationMs > 0) {
    const seconds = durationMs / 1000;
    const costUsd = sttCostUsd(provider, seconds);
    log.debug("ingest: stt usage recorded", { provider, seconds, costUsd, cached: false });
    void recordUsage({
      kind: "stt",
      category: "transcription",
      provider,
      model: "",
      seconds,
      costUsd,
    });
  } else {
    log.debug("ingest: billing skipped (cached)");
  }

  return {
    id: crypto.randomUUID(),
    name,
    audioPath,
    // Asset protocol URL — supports HTTP range requests so the <audio> element
    // can seek/scrub. Enabled via tauri.conf.json app.security.assetProtocol.
    audioSrc: convertFileSrc(audioPath),
    durationMs,
    createdAt: Date.now(),
    segments,
    speakerNames: {},
    speechRateHz: result.speechRateHz || null,
  };
}

/** Surface a progress stage to both the UI callback and the log file. */
function reportStage(opts: IngestOptions, p: IngestProgress): void {
  log.debug("ingest: stage", { stage: p.stage });
  opts.onProgress?.(p);
}

/** Last path component of an absolute file path (handles / and \\). */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
