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

/** The i18n keys a localized speaker label is built from. */
export type SpeakerLabelKey = "speaker.you" | "speaker.speaker" | "speaker.remote" | "speaker.them";

/** A translator for those keys — `useI18n().t`, or `translate` bound to a language. */
export type SpeakerLabelT = (key: SpeakerLabelKey, vars?: Record<string, string | number>) => string;

/**
 * The default label on SCREEN (你 / 說話者 N / 遠端 N / 對方, or the English
 * forms): the same source/number rules as {@link defaultSpeakerLabel}, in the
 * app language. Text sent to a model keeps the English form.
 */
export function localizedDefaultSpeakerLabel(
  s: Pick<TranscriptSegment, "source" | "speaker">,
  t: SpeakerLabelT,
): string {
  const displaySpeaker = s.speaker === 0 ? 1 : s.speaker ?? 1;
  if (s.source === "mix") return t("speaker.speaker", { number: displaySpeaker });
  if (s.source === "me") {
    return displaySpeaker <= 1 ? t("speaker.you") : t("speaker.speaker", { number: displaySpeaker });
  }
  return s.speaker > 0 ? t("speaker.remote", { number: s.speaker }) : t("speaker.them");
}

/** Who said `s`, as every on-screen label and user-copied text shows it: the
 *  name the user gave that speaker, else the localized default. */
export function displaySpeakerLabel(
  s: Pick<TranscriptSegment, "source" | "speaker">,
  names: Record<string, string> | undefined,
  t: SpeakerLabelT,
): string {
  return names?.[speakerKey(s)] || localizedDefaultSpeakerLabel(s, t);
}
