// Transcripts that arrive with no timing at all.
//
// The phone apps' batch transcription (a re-transcribed meeting, or an imported
// file) read the cloud's token timing under the wrong key until #576, so every
// line it produced was stamped 0 → 0. Those recordings synced to the cloud that
// way and the real timing is not recoverable from the transcript: the audio is
// fine, the text is fine, but every line claims to start at 00:00. Everything
// downstream reads `startMs` — the findings timeline, the brief's [m:ss] links,
// action items, transcript seek, the speaker strip — so all of it collapsed to
// the first second.
//
// The repair is an ESTIMATE, not a recovery: lines are laid end to end over the
// recording, each taking a share of it proportional to how long it takes to say
// (the same per-character model the plain-text import uses). It is close enough
// to jump to the right part of a meeting, and the replay screen says it is an
// estimate. The estimate is never written back as if it were measured — see
// {@link withoutEstimatedTiming} — so the saved meta keeps saying "no timing",
// and a later re-transcription (on the phone) replaces it with the real thing.
//
// The Rust MCP server (`src-tauri/src/mcp.rs`, `estimated_starts`) applies the
// same estimate to the transcripts it hands an external analyst, so a finding
// it anchors at [m:ss] lands on the same line here. Keep the two in step — the
// shared fixture in timing.test.ts and the Rust test pin the same numbers.

import type { TranscriptSegment } from "../types";
import { estimateSpeechMs } from "./importTranscript";

/**
 * True when a transcript carries no timing at all: at least two spoken lines,
 * and every one of them starts AND ends at 0. That is exactly the signature of
 * the phone bug above — no real transcript has two spoken lines that both
 * occupy no time at the very start of the recording, so this never fires on a
 * transcript with genuine timing (a live meeting's first line at 0:00 is fine:
 * its end is not 0, and the next line's start is not either).
 */
export function hasMissingTiming(segments: readonly TranscriptSegment[]): boolean {
  let spoken = 0;
  for (const s of segments) {
    if (!s.text.trim()) continue;
    if (s.startMs !== 0 || s.endMs !== 0) return false;
    spoken++;
  }
  return spoken >= 2;
}

/**
 * Lay the lines of an untimed transcript end to end over `durationMs`, each
 * taking a share proportional to {@link estimateSpeechMs} of its text. With no
 * usable duration the per-line estimates are used as-is. Blank lines get a
 * zero-length slot where they fall. Input order is kept (it is the transcript's
 * order — there is no timing to sort by). Pure.
 */
export function estimateMissingTiming(
  segments: readonly TranscriptSegment[],
  durationMs: number,
): TranscriptSegment[] {
  const weights = segments.map((s) => (s.text.trim() ? estimateSpeechMs(s.text) : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const scale = total > 0 && Number.isFinite(durationMs) && durationMs > 0 ? durationMs / total : 1;
  let cursor = 0;
  return segments.map((s, i) => {
    const startMs = Math.round(cursor * scale);
    cursor += weights[i];
    return { ...s, startMs, endMs: Math.round(cursor * scale) };
  });
}

/**
 * The transcript as it should be shown: untimed ones get the estimate above,
 * anything else comes back untouched (same array). `estimated` says which.
 */
export function withTimingRepaired(
  segments: TranscriptSegment[],
  durationMs: number,
): { segments: TranscriptSegment[]; estimated: boolean } {
  if (!hasMissingTiming(segments)) return { segments, estimated: false };
  return { segments: estimateMissingTiming(segments, durationMs), estimated: true };
}

/**
 * Undo {@link estimateMissingTiming} for persistence: the saved transcript keeps
 * the 0 → 0 timing it came with, so it still reads as "no timing" to every
 * device instead of passing a guess off as a measurement. Reloading re-derives
 * the same estimate (it only depends on the text and the duration).
 */
export function withoutEstimatedTiming(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((s) => ({ ...s, startMs: 0, endMs: 0 }));
}
