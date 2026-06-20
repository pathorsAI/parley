// Recording upload + batch transcription.
//
// Lets the user pick an audio file, sends it through Soniox's async/batch API
// (diarized, with word/segment timestamps), and returns a `ReplaySession` the
// replay UI can play and scrub. Only Soniox is supported today; other providers
// throw a clear "switch to Soniox" error.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Settings, TranscriptSegment } from "../types";
import type { ReplaySession } from "./types";
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
  "opus",
  "wma",
  "webm",
  "mp4",
];

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
  /** True when served from the on-disk cache (no Soniox call → don't bill it). */
  cached: boolean;
}

/**
 * Open a file picker, transcribe the chosen recording via Soniox's batch API,
 * and resolve to a `ReplaySession`. Returns `null` if the user cancels.
 *
 * Every segment is tagged `source: "them"` (single mixed file — speakers are
 * told apart by diarization) and `isFinal: true`.
 */
/**
 * Validate the provider + open the native file picker. Returns the chosen audio
 * path, or `null` if the user cancelled. Throws if Soniox isn't configured. Split
 * out from transcription so the ingest wizard can ask the speaker count BEFORE
 * the (slow) transcription runs.
 */
export async function pickRecordingFile(settings: Settings): Promise<string | null> {
  if (settings.transcriptionProvider !== "soniox") {
    log.warn("ingest: rejected, provider not soniox", { provider: settings.transcriptionProvider });
    throw new Error(
      "Replay currently supports Soniox only — switch transcription provider to Soniox in Settings",
    );
  }
  if (!settings.sonioxApiKey?.trim()) {
    log.warn("ingest: missing soniox key");
    throw new Error("Add your Soniox API key in Settings to transcribe recordings");
  }

  const selected = await open({
    multiple: false,
    directory: false,
    title: "Choose a recording",
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (selected === null) return null; // user cancelled
  const audioPath = Array.isArray(selected) ? selected[0] : selected;
  return audioPath || null;
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
  const apiKey = settings.sonioxApiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your Soniox API key in Settings to transcribe recordings");
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
  log.info("ingest: transcribe invoke", { languageHints, diarization: true });
  const result = await invoke<RustTranscriptionResult>("transcribe_file", {
    path: audioPath,
    apiKey,
    model: null,
    languageHints,
    diarization: true,
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

  // Bill the audio transcription — but only when it actually hit Soniox. A cache
  // hit cost nothing, so recording it would over-count. (LLM costs for evals etc.
  // are billed separately via recordLlmUsage.)
  if (!result.cached && durationMs > 0) {
    const seconds = durationMs / 1000;
    const costUsd = sttCostUsd("soniox", seconds);
    log.debug("ingest: stt usage recorded", { seconds, costUsd, cached: false });
    void recordUsage({
      kind: "stt",
      category: "transcription",
      provider: "soniox",
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
  };
}

/** Pick a recording then transcribe it — the original one-shot ingest. */
export async function ingestRecording(
  settings: Settings,
  opts: IngestOptions = {},
): Promise<ReplaySession | null> {
  const audioPath = await pickRecordingFile(settings);
  if (!audioPath) return null;
  return transcribeRecording(settings, audioPath, opts);
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
