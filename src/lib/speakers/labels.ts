// Speaker identity and display labels for transcript lines.
//
// Names follow the capture side: the mic is "me", the system audio "remote".
// One voice on the mic is just "Me"; once the mic carries several voices
// (people sharing the laptop, or diarization splitting the room) they become
// "Me 1", "Me 2". Far-side voices are "Remote 1", "Remote 2". A diarized mixed
// recording has no side, so its voices are "Speaker 1", "Speaker 2".

import type { TranscriptSegment } from "../types";

type SpeakerRef = Pick<TranscriptSegment, "source" | "speaker">;

/** What a label needs to know beyond the line itself. */
export interface LabelContext {
  /** Distinct diarized voices on the mic side (see {@link labelContextOf}). */
  micSpeakers?: number;
}

/** Which kind of label a speaker gets, independent of language. */
export type LabelPart =
  | { kind: "me" }
  | { kind: "meNumbered"; number: number }
  | { kind: "remote"; number: number }
  | { kind: "them" }
  | { kind: "speaker"; number: number };

/**
 * A stable key per distinct speaker. Includes the diarized speaker number on
 * BOTH sources, so multiple people sharing the mic (in-person) are separated,
 * not just remote speakers on the system-audio side.
 */
export function speakerKey(s: SpeakerRef): string {
  return `${s.source}-${s.speaker ?? 0}`;
}

/** The context every label of one transcript shares. */
export function labelContextOf(segments: readonly TranscriptSegment[]): LabelContext {
  const mic = new Set<number>();
  for (const s of segments) {
    if (s.source === "me" && s.speaker > 0 && s.text.trim()) mic.add(s.speaker);
  }
  return { micSpeakers: mic.size };
}

export function labelPart(s: SpeakerRef, ctx: LabelContext = {}): LabelPart {
  const n = s.speaker > 0 ? s.speaker : 1;
  if (s.source === "mix") return { kind: "speaker", number: n };
  if (s.source === "me") {
    // Without context, a second mic voice still shows up numbered.
    const several = (ctx.micSpeakers ?? 0) > 1 || s.speaker > 1;
    return several ? { kind: "meNumbered", number: n } : { kind: "me" };
  }
  return s.speaker > 0 ? { kind: "remote", number: s.speaker } : { kind: "them" };
}

/** Default English label (no custom name); also what LLM prompts see. */
export function defaultSpeakerLabel(s: SpeakerRef, ctx?: LabelContext): string {
  const p = labelPart(s, ctx);
  switch (p.kind) {
    case "me":
      return "Me";
    case "meNumbered":
      return `Me ${p.number}`;
    case "remote":
      return `Remote ${p.number}`;
    case "them":
      return "Them";
    case "speaker":
      return `Speaker ${p.number}`;
  }
}

/** Display label, preferring a user-assigned name from `names` when present. */
export function speakerLabel(s: SpeakerRef, names?: Record<string, string>, ctx?: LabelContext): string {
  return names?.[speakerKey(s)] ?? defaultSpeakerLabel(s, ctx);
}

/** The i18n key and params for a label, for UI that speaks the user's language. */
export function labelMessage(
  s: SpeakerRef,
  ctx?: LabelContext,
): { key: "speaker.me" | "speaker.meNumbered" | "speaker.remote" | "speaker.them" | "speaker.speaker"; params?: { number: number } } {
  const p = labelPart(s, ctx);
  switch (p.kind) {
    case "me":
      return { key: "speaker.me" };
    case "meNumbered":
      return { key: "speaker.meNumbered", params: { number: p.number } };
    case "remote":
      return { key: "speaker.remote", params: { number: p.number } };
    case "them":
      return { key: "speaker.them" };
    case "speaker":
      return { key: "speaker.speaker", params: { number: p.number } };
  }
}

type Translate = (key: ReturnType<typeof labelMessage>["key"], params?: { number: number }) => string;

/** {@link defaultSpeakerLabel} in the UI language (pass the i18n `t`). */
export function localizedDefaultLabel(s: SpeakerRef, t: Translate, ctx?: LabelContext): string {
  const m = labelMessage(s, ctx);
  return t(m.key, m.params);
}

/** {@link speakerLabel} in the UI language: the custom name, else the default. */
export function localizedSpeakerLabel(
  s: SpeakerRef,
  t: Translate,
  names?: Record<string, string>,
  ctx?: LabelContext,
): string {
  return names?.[speakerKey(s)] ?? localizedDefaultLabel(s, t, ctx);
}
