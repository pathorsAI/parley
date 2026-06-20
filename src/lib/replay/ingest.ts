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
}

/**
 * Open a file picker, transcribe the chosen recording via Soniox's batch API,
 * and resolve to a `ReplaySession`. Returns `null` if the user cancels.
 *
 * Every segment is tagged `source: "them"` (single mixed file — speakers are
 * told apart by diarization) and `isFinal: true`.
 */
export async function ingestRecording(
  settings: Settings,
  opts: IngestOptions = {},
): Promise<ReplaySession | null> {
  if (settings.transcriptionProvider !== "soniox") {
    throw new Error(
      "Replay currently supports Soniox only — switch transcription provider to Soniox in Settings",
    );
  }

  const apiKey = settings.sonioxApiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your Soniox API key in Settings to transcribe recordings");
  }

  const selected = await open({
    multiple: false,
    directory: false,
    title: "Choose a recording",
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });

  // User cancelled the dialog.
  if (selected === null) return null;
  const audioPath = Array.isArray(selected) ? selected[0] : selected;
  if (!audioPath) return null;

  opts.onProgress?.({ stage: "decoding" });

  // Language hints come from settings if present; empty lets Soniox auto-detect.
  const languageHints = languageHintsFromSettings(settings);

  opts.onProgress?.({ stage: "uploading" });

  // The Rust command uploads the file, creates the async job, polls to
  // completion, then fetches the diarized tokens. It owns the network + secrets.
  opts.onProgress?.({ stage: "transcribing" });
  const result = await invoke<RustTranscriptionResult>("transcribe_file", {
    path: audioPath,
    apiKey,
    model: null,
    languageHints,
    diarization: true,
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

  return {
    id: crypto.randomUUID(),
    name: fileNameOf(audioPath),
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
