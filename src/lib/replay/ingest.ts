// Recording upload + batch transcription.
//
// Lets the user pick an audio file, sends it through the selected provider's
// batch transcription API (diarized where the provider supports it, with
// word/segment timestamps), and returns a `ReplaySession` the replay UI can play
// and scrub. Which providers are eligible is gated by `supportsFileUpload` in the
// STT registry — the backend dispatch (`replay.rs::transcribe_file`) must
// implement each one before its flag flips on. Today that's Soniox only.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Settings, TranscriptSegment } from "../types";
import { useStore } from "../store";
import type { ReplaySession } from "./types";
import { STT_BY_ID, sttApiKey } from "../transcription/providers";
import { toTraditional } from "../zhConvert";
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

const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join("|")})$`, "i");

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

/** Throw (with the actionable message) unless the configured STT provider can
 *  batch-transcribe an uploaded file. Only audio needs this — text transcripts
 *  import without any provider. */
function assertUploadTranscribable(settings: Settings): void {
  const provider = settings.transcriptionProvider;
  const info = STT_BY_ID[provider];
  if (!info.supportsFileUpload) {
    log.warn("ingest: rejected, provider has no file-upload support", { provider });
    throw new Error(
      `Uploading a recording isn't supported for ${info.label} yet — switch the transcription provider to Soniox in Settings.`,
    );
  }
  if (!sttApiKey(settings, provider).trim()) {
    log.warn("ingest: missing stt key", { provider });
    throw new Error(`Add your ${info.label} API key in Settings to transcribe recordings.`);
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
 * the library header, a company page, the coach-feed empty state — runs this
 * one flow, so the accepted formats and the audio-vs-transcript arbitration
 * can never drift between doors. Doors differ only in prefill: a company page
 * passes its `companyId` so the resulting entry is pre-linked to the company
 * (and lands in its paired folder). Throws the STT-gate errors from
 * {@link pickImportFiles} — callers toast them.
 */
export async function startImportFlow(
  opts: { companyId?: string | null } = {},
): Promise<void> {
  const pick = await pickImportFiles(useStore.getState().settings);
  if (!pick) return;
  routeImportPick(pick, opts.companyId ?? null);
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

/** Open the right dialog for an arbitrated pick. `companyId` pre-links first:
 *  audio via the meeting link (the wizard's save snapshots `meetingCompanyId`
 *  and resolveMeetingSave files it under the company folder), transcripts by
 *  riding on the import dialog. A null companyId leaves any existing meeting
 *  link alone rather than clearing it — and since #211 both dialogs SHOW the
 *  customer they are about to file under, so an inherited link is on screen and
 *  one click from being changed instead of being applied silently. */
function routeImportPick(pick: ImportPick, companyId: string | null): void {
  const { openIngestWizard, openTranscriptImport, setMeetingLink } = useStore.getState();
  if (pick.kind === "audio") {
    if (companyId) setMeetingLink({ companyId, threadId: null, attendeeIds: [] });
    openIngestWizard(pick.path);
  } else {
    openTranscriptImport(pick.paths, companyId);
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
 * Transcribe an already-picked recording into a `ReplaySession` (diarized batch
 * transcription via Soniox). Reports decoding/uploading/transcribing stages.
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
    throw new Error(`Add your ${info.label} API key in Settings to transcribe recordings.`);
  }

  const name = fileNameOf(audioPath);
  log.info("ingest: file selected", { name });

  reportStage(opts, { stage: "decoding" });

  // Language hints come from settings if present; empty lets Soniox auto-detect.
  const languageHints = languageHintsFromSettings(settings);

  reportStage(opts, { stage: "uploading" });

  // The Rust command uploads the file, creates the async job, polls to
  // completion, then fetches the diarized tokens. It owns the network + secrets.
  reportStage(opts, { stage: "transcribing" });
  log.info("ingest: transcribe invoke", { provider, languageHints, diarization: info.diarization });
  const result = await invoke<RustTranscriptionResult>("transcribe_file", {
    path: audioPath,
    provider,
    apiKey,
    model: null,
    languageHints,
    diarization: info.diarization,
  });
  log.info("ingest: transcription ok", {
    segments: result.segments.length,
    durationMs: result.durationMs,
    cached: result.cached,
  });

  // Soniox returns Simplified for zh audio; convert to Traditional to match the
  // live transcription path (tauriEvents.ts also runs OpenCC cn→tw on segments).
  const segments: TranscriptSegment[] = await Promise.all(
    result.segments.map(async (s) => ({
      id: s.id,
      source: "them" as const,
      speaker: s.speaker,
      text: await toTraditional(s.text),
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

/** Derive BCP-47 language hints from settings; empty array = auto-detect. */
function languageHintsFromSettings(settings: Settings): string[] {
  // The UI language is the only locale signal we currently persist. Map it to a
  // hint and pair it with English, which covers the common bilingual case.
  if (settings.language === "zh-TW") return ["zh", "en"];
  if (settings.language === "en") return ["en"];
  return [];
}

/** Last path component of an absolute file path (handles / and \\). */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
