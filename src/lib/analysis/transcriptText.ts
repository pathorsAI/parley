// The transcript rendered as text: the LLM prompt context and the copy formats.

import type { TranscriptSegment } from "../types";
import { speakerLabel } from "../speakers/labels";

/** Final, non-empty segments in start-time order — what every text form reads. */
function spokenInOrder(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments]
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
}

/** Final-only transcript text, labelled by speaker (with custom names) — LLM context. */
export function transcriptAsText(
  segments: TranscriptSegment[],
  names?: Record<string, string>
): string {
  return spokenInOrder(segments)
    .map((s) => `[${speakerLabel(s, names)}] ${s.text.trim()}`)
    .join("\n");
}

/** Format a meeting-relative millisecond offset as m:ss. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Like transcriptAsText but each line is prefixed with its [m:ss] start time,
 *  so the model can cite moments the UI can jump back to. */
export function transcriptWithTimestamps(
  segments: TranscriptSegment[],
  names?: Record<string, string>
): string {
  return spokenInOrder(segments)
    .map((s) => `[${formatClock(s.startMs)}] [${speakerLabel(s, names)}] ${s.text.trim()}`)
    .join("\n");
}

/** Final-only transcript as plain spoken text — one segment per line, no speaker
 *  or timestamp labels. The bare-bones copy variant for pasting elsewhere. */
export function transcriptPlainText(segments: TranscriptSegment[]): string {
  return spokenInOrder(segments)
    .map((s) => s.text.trim())
    .join("\n");
}
