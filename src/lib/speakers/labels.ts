// Speaker identity and display labels for transcript lines.

import type { TranscriptSegment } from "../types";

/**
 * A stable key per distinct speaker. Includes the diarized speaker number on
 * BOTH sources, so multiple people sharing the mic (in-person) are separated,
 * not just remote speakers on the system-audio side.
 */
export function speakerKey(s: Pick<TranscriptSegment, "source" | "speaker">): string {
  return `${s.source}-${s.speaker ?? 0}`;
}

/** Default label (no custom name). The primary mic voice is "You". */
export function defaultSpeakerLabel(s: Pick<TranscriptSegment, "source" | "speaker">): string {
  const displaySpeaker = s.speaker === 0 ? 1 : s.speaker ?? 1;
  // Mixed stream: no deterministic me/them — label purely by diarized speaker.
  if (s.source === "mix") return `Speaker ${displaySpeaker}`;
  if (s.source === "me") return displaySpeaker <= 1 ? "You" : `Speaker ${displaySpeaker}`;
  return s.speaker > 0 ? `Remote ${s.speaker}` : "Them";
}

/** Display label, preferring a user-assigned name from `names` when present. */
export function speakerLabel(
  s: Pick<TranscriptSegment, "source" | "speaker">,
  names?: Record<string, string>
): string {
  return names?.[speakerKey(s)] ?? defaultSpeakerLabel(s);
}
