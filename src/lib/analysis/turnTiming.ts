//! Turn-timing facts for the post-meeting delivery scorecard: long pauses inside
//! the user's own speech, and the times the user cut in on the other side.
//!
//! Both read only segment timing (no audio, no model) and both need speakers
//! split by capture source — "me" is the user's mic, "them" the system audio.
//! In a diarized "mix" session, or one where the far side was never captured,
//! there is no telling whose silence or whose overlap it was, so the functions
//! return null and the scorecard shows a dash (same rule as talkTimeRatio).

import type { TranscriptSegment } from "../types";

/** A gap of at least this long between two of the user's own segments, with
 *  nobody else talking in it, counts as a pause. */
export const PAUSE_MIN_MS = 3000;

/** Starting this soon after the other side stopped — while they were still
 *  mid-sentence — counts as cutting in, even without an actual overlap. */
export const INTERRUPT_GRACE_MS = 300;

/** Sentence-final punctuation: a segment ending in one of these was a finished
 *  thought, so an immediate reply to it is a fast turn, not a cut-in. */
const SENTENCE_END = /[。？！?!.…」』)）~～]\s*$/u;

/** Finalized, non-empty segments of the two sides, in time order. Null when the
 *  session is not source-split (both sides must be present). */
function splitTurns(segments: TranscriptSegment[]): TranscriptSegment[] | null {
  const spoken = segments
    .filter((s) => s.isFinal && s.text.trim() && s.endMs > s.startMs && (s.source === "me" || s.source === "them"))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const sawMe = spoken.some((s) => s.source === "me");
  const sawThem = spoken.some((s) => s.source === "them");
  return sawMe && sawThem ? spoken : null;
}

/**
 * Long pauses inside the user's own speech: two consecutive "me" segments
 * separated by ≥ {@link PAUSE_MIN_MS}, where no "them" segment started in
 * between or still ran into the gap. A silence the other side filled is a turn
 * change, not a pause; a silence before the user's first word is not counted.
 */
export function countLongPauses(segments: TranscriptSegment[]): number | null {
  const turns = splitTurns(segments);
  if (!turns) return null;
  let pauses = 0;
  let prevMe: TranscriptSegment | null = null;
  // Latest end of any "them" segment seen so far — a long one can start before
  // the user's segment and still run into the gap after it.
  let themEnd = -Infinity;
  let themSincePrevMe = false;
  for (const s of turns) {
    if (s.source === "them") {
      themEnd = Math.max(themEnd, s.endMs);
      themSincePrevMe = true;
      continue;
    }
    if (prevMe && !themSincePrevMe && themEnd <= prevMe.endMs && s.startMs - prevMe.endMs >= PAUSE_MIN_MS) {
      pauses += 1;
    }
    // Overlapping "me" segments: keep the later end so the gap is measured from
    // where the user actually went quiet.
    if (!prevMe || themSincePrevMe || s.endMs > prevMe.endMs) prevMe = s;
    themSincePrevMe = false;
  }
  return pauses;
}

/**
 * Times the user cut in on the other side. A "me" segment interrupts the most
 * recent "them" segment that started before it when either
 *   • it starts before that segment ended (talking over them), or
 *   • it starts within {@link INTERRUPT_GRACE_MS} of that segment ending while
 *     the segment did not end on sentence-final punctuation (jumping in before
 *     they finished the thought).
 * Each "them" segment is counted at most once, so a run of backchannels over
 * one long turn is one interruption, not several.
 */
export function countInterruptions(segments: TranscriptSegment[]): number | null {
  const turns = splitTurns(segments);
  if (!turns) return null;
  let interruptions = 0;
  let lastThem: TranscriptSegment | null = null;
  let lastThemCounted = false;
  for (const s of turns) {
    if (s.source === "them") {
      lastThem = s;
      lastThemCounted = false;
      continue;
    }
    if (!lastThem || lastThemCounted || s.startMs <= lastThem.startMs) continue;
    const overlap = s.startMs < lastThem.endMs;
    const cutIn = s.startMs - lastThem.endMs < INTERRUPT_GRACE_MS && !SENTENCE_END.test(lastThem.text);
    if (overlap || cutIn) {
      interruptions += 1;
      lastThemCounted = true;
    }
  }
  return interruptions;
}
