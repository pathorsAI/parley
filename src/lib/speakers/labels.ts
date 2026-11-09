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
export function labelContextOf(
  segments: readonly (SpeakerRef & { text?: string })[],
): LabelContext {
  const mic = new Set<number>();
  for (const s of segments) {
    if (s.source === "me" && s.speaker > 0 && (s.text === undefined || s.text.trim())) mic.add(s.speaker);
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

/**
 * Every English label `s` may have been given, newest first: with this
 * transcript's context, without it, and the pre-side naming ("You",
 * "Speaker 2" for a second mic voice) that analyses saved before the rename
 * still quote. For matching model-written text back to a speaker.
 */
export function knownDefaultLabels(s: SpeakerRef, ctx?: LabelContext): string[] {
  const out = [defaultSpeakerLabel(s, ctx), defaultSpeakerLabel(s)];
  if (s.source === "me") out.push(s.speaker > 1 ? `Speaker ${s.speaker}` : "You");
  return [...new Set(out)];
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

/** The i18n keys a localized speaker label is built from. */
export type SpeakerLabelKey = ReturnType<typeof labelMessage>["key"];

/** A translator for those keys — `useI18n().t`, or `translate` bound to a language. */
export type SpeakerLabelT = (key: SpeakerLabelKey, vars?: Record<string, string | number>) => string;

/**
 * The default label on SCREEN (我 / 我 N / 遠端 N / 對方 / 說話者 N, or the
 * English forms): the same rules as {@link defaultSpeakerLabel}, in the app
 * language. Text sent to a model keeps the English form. `ctx` from
 * {@link labelContextOf} numbers the first mic voice once there are several.
 */
export function localizedDefaultSpeakerLabel(s: SpeakerRef, t: SpeakerLabelT, ctx?: LabelContext): string {
  const m = labelMessage(s, ctx);
  return t(m.key, m.params);
}

/** Who said `s`, as every on-screen label and user-copied text shows it: the
 *  name the user gave that speaker, else the localized default. */
export function displaySpeakerLabel(
  s: SpeakerRef,
  names: Record<string, string> | undefined,
  t: SpeakerLabelT,
  ctx?: LabelContext,
): string {
  return names?.[speakerKey(s)] || localizedDefaultSpeakerLabel(s, t, ctx);
}
