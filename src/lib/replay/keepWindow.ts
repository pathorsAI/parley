// The replay keep-window as a predicate over transcript lines.

import type { TranscriptSegment } from "../types";
import type { ReplayTrim } from "../store/types";

/**
 * Is this segment outside the replay keep-window (i.e. trimmed away)? A segment
 * is KEPT when it overlaps [startMs, endMs] at all, so a turn straddling a trim
 * boundary stays. `null` trim means nothing is trimmed. Used to grey trimmed
 * lines in the transcript and to exclude them from every replay analysis.
 */
export function isTrimmed(
  s: Pick<TranscriptSegment, "startMs" | "endMs">,
  trim: ReplayTrim | null
): boolean {
  if (!trim) return false;
  return s.endMs < trim.startMs || s.startMs > trim.endMs;
}

/**
 * Is there any spoken (final, non-empty) content inside the keep-window? THE
 * shared "can an analysis pass run" predicate — the study pipeline's scheduler
 * and every runner's own guard must agree on it, or a stage gets offered
 * forever while its runner silently declines.
 */
export function hasSpokenSegment(
  segments: TranscriptSegment[],
  trim: ReplayTrim | null = null
): boolean {
  return segments.some((s) => !isTrimmed(s, trim) && s.isFinal && s.text.trim());
}
