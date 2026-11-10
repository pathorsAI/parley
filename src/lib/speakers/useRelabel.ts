// React + store bindings for the on-screen speaker labels and the relabelling
// of AI-written text (see labels.ts and relabel.ts).

import { useCallback, useMemo } from "react";
import { translate } from "../../i18n/messages";
import { useStore } from "../store";
import type { AppLanguage, TranscriptSegment } from "../types";
import { displaySpeakerLabel, type SpeakerLabelT } from "./labels";
import { speakerRelabeler } from "./relabel";

type Line = Pick<TranscriptSegment, "source" | "speaker">;
type StoreState = ReturnType<typeof useStore.getState>;

/** The speaker-label translator for `lang`, outside React. */
export function speakerT(lang: AppLanguage): SpeakerLabelT {
  return (key, vars) => translate(lang, key, vars);
}

/** `(seg) => label` as the screen shows it, for a store snapshot. */
export function displayLabelerOf(s: StoreState, lang: AppLanguage = s.settings.language): (seg: Line) => string {
  const t = speakerT(lang);
  return (seg) => displaySpeakerLabel(seg, s.speakerNames, t);
}

/** Relabel AI text against a store snapshot (copy paths, outside React). */
export function relabelFromState(
  s: StoreState,
  lang: AppLanguage = s.settings.language,
): (text: string) => string {
  return speakerRelabeler(s.segments, s.speakerNames, s.speakerAliases, displayLabelerOf(s, lang));
}

/** `(seg) => label` for the current names and app language. */
export function useSpeakerLabel(): (seg: Line) => string {
  const names = useStore((s) => s.speakerNames);
  const lang = useStore((s) => s.settings.language);
  return useCallback((seg: Line) => displaySpeakerLabel(seg, names, speakerT(lang)), [names, lang]);
}

/**
 * `(text) => text` with every speaker cited by an old label shown under its
 * current one. Render-time only — stored artifacts are never rewritten.
 */
export function useRelabel(): (text: string) => string {
  const segments = useStore((s) => s.segments);
  const names = useStore((s) => s.speakerNames);
  const aliases = useStore((s) => s.speakerAliases);
  const lang = useStore((s) => s.settings.language);
  return useMemo(() => sharedRelabeler(segments, names, aliases, lang), [segments, names, aliases, lang]);
}

/** The last relabeler built, shared by every row that renders AI text (each
 *  finding row would otherwise rescan the transcript on every live update). */
let lastRelabeler: {
  segments: readonly Line[];
  names: Record<string, string>;
  aliases: Record<string, string[]>;
  lang: AppLanguage;
  fn: (text: string) => string;
} | null = null;

function sharedRelabeler(
  segments: readonly Line[],
  names: Record<string, string>,
  aliases: Record<string, string[]>,
  lang: AppLanguage,
): (text: string) => string {
  const c = lastRelabeler;
  if (c && c.segments === segments && c.names === names && c.aliases === aliases && c.lang === lang) return c.fn;
  const t = speakerT(lang);
  const fn = speakerRelabeler(segments, names, aliases, (seg) => displaySpeakerLabel(seg, names, t));
  lastRelabeler = { segments, names, aliases, lang, fn };
  return fn;
}
