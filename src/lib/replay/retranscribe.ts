// Re-transcribe a saved recording (#680).
//
// A recording whose transcript came back broken — empty, cut short, garbled, or
// recovered after a crash with no transcript at all — still has its audio in the
// entry folder. This sends that audio through the same batch lane an imported
// file uses (`transcribeRecording`), then swaps the new transcript into the
// entry on disk and in the cloud copy, and reopens it so the analysis runs again
// on the new text.
//
// The old transcript is only replaced once a usable new one is in hand: any
// failure, or a result with nothing spoken in it, leaves the entry exactly as it
// was.

import { useStore, isMeetingActive, hasSpokenSegment } from "../store";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { translate } from "../../i18n/messages";
import { speakerKey } from "../speakers/labels";
import type { ReplaySession } from "./types";
import type { HistoryEntry } from "../history/types";
import { transcribeRecording, type IngestOptions } from "./ingest";

/** Why the current replay can't be re-transcribed, or null when it can. */
export type RetranscribeBlock = "not-desktop" | "no-session" | "read-only" | "no-audio" | "recording";

/** The state {@link retranscribeBlock} reads — a slice, so the rule is testable. */
export interface RetranscribeState {
  replay: Pick<ReplaySession, "audioPath"> | null;
  loadedHistoryId: string | null;
  replayReadOnly: boolean;
  meetingStatus: Parameters<typeof isMeetingActive>[0];
}

/**
 * Whether the loaded recording can be re-transcribed. Only an own saved entry
 * with its audio on disk qualifies: an org recording is someone else's (and its
 * audio is only a temp download), an audio-less transcript import has nothing to
 * send, and a live meeting owns the transcript store. Pure + exported for tests.
 */
export function retranscribeBlock(s: RetranscribeState, desktop = isTauri()): RetranscribeBlock | null {
  if (!desktop) return "not-desktop";
  if (!s.replay) return "no-session";
  if (s.replayReadOnly || !s.loadedHistoryId) return "read-only";
  if (!s.replay.audioPath) return "no-audio";
  if (isMeetingActive(s.meetingStatus)) return "recording";
  return null;
}

/**
 * The speaker names to carry over. Names are keyed by speaker (`them-1`…), and a
 * new diarization numbers speakers afresh, so a name is only still right when the
 * new transcript has exactly the same set of speakers. Anything else resets to
 * the defaults rather than putting a name on the wrong voice. Pure + exported.
 */
export function carriedSpeakerNames(
  oldNames: Record<string, string>,
  oldSegments: HistoryEntry["segments"],
  newSegments: HistoryEntry["segments"],
): Record<string, string> {
  if (Object.keys(oldNames).length === 0) return {};
  const keys = (segs: HistoryEntry["segments"]) => new Set(segs.map(speakerKey));
  const before = keys(oldSegments);
  const after = keys(newSegments);
  if (before.size !== after.size || [...before].some((k) => !after.has(k))) return {};
  return Object.fromEntries(Object.entries(oldNames).filter(([k]) => after.has(k)));
}

/**
 * The entry after a re-transcription: the new transcript, and every output that
 * was derived from the OLD transcript cleared, so opening it runs the analysis
 * again (`analyzed: false`) instead of showing findings that point at lines that
 * no longer exist. What the user set by hand — title, folder, meeting context and
 * negotiation setup, meeting kind — stays. Pure + exported for testing.
 */
export function retranscribedEntry(meta: HistoryEntry, fresh: ReplaySession): HistoryEntry {
  return {
    ...meta,
    segments: fresh.segments,
    speakerNames: carriedSpeakerNames(meta.speakerNames ?? {}, meta.segments ?? [], fresh.segments),
    // The provider measured the file; a recovered recording may have been saved
    // with a duration that stopped short of it.
    durationMs: Math.max(meta.durationMs || 0, fresh.durationMs || 0),
    speechRateHz: fresh.speechRateHz ?? meta.speechRateHz ?? null,
    findings: [],
    actionItems: [],
    analyzed: false,
    brief: null,
    briefFailed: false,
    deliveryAssessment: null,
  };
}

/** Thrown when the provider answered but nothing in the result was spoken. */
export class EmptyRetranscriptionError extends Error {}

/**
 * Re-transcribe the recording on screen and save the result over its transcript.
 * Throws (leaving the entry untouched) when it can't run, when transcription
 * fails, or when the new transcript is empty. Resolves once the new transcript
 * is saved and reopened.
 */
export async function retranscribeLoadedRecording(opts: Pick<IngestOptions, "onProgress"> = {}): Promise<void> {
  const state = useStore.getState();
  const block = retranscribeBlock(state);
  const lang = state.settings.language;
  if (block) throw new Error(translate(lang, `replay.retranscribe.block.${block}`));
  const id = state.loadedHistoryId!;
  const audioPath = state.replay!.audioPath;

  log.info("retranscribe: start", { id, provider: state.settings.transcriptionProvider });
  const fresh = await transcribeRecording(state.settings, audioPath, { ...opts, fresh: true });
  if (!hasSpokenSegment(fresh.segments)) {
    log.warn("retranscribe: result has no speech; keeping the old transcript", {
      id,
      segments: fresh.segments.length,
    });
    throw new EmptyRetranscriptionError(translate(lang, "replay.retranscribe.empty"));
  }

  // Imported lazily: history.ts pulls in the whole save/sync graph, which the
  // pure helpers above (and their tests) don't need.
  const { rewriteEntry, emitHistoryUpdated } = await import("../history/entryStore");
  const { pushToCloud } = await import("../history/cloudPush");
  const { loadHistoryEntry } = await import("../history/open");

  const saved = await rewriteEntry(id, (meta) => retranscribedEntry(meta, fresh));
  log.info("retranscribe: saved", {
    id,
    segments: saved.segments.length,
    durationMs: saved.durationMs,
    namesKept: Object.keys(saved.speakerNames).length,
  });
  await emitHistoryUpdated(id).catch(() => {});
  pushToCloud(id).catch((e) => log.warn("retranscribe: cloud push failed", { id, error: String(e) }));

  // Reopen only if the user is still on this recording — they may have moved on
  // during a long transcription, and yanking them back would be worse than the
  // stale view (the library already shows the new transcript).
  if (useStore.getState().loadedHistoryId === id) await loadHistoryEntry(id);
}
