// After the meeting: which live suggestions did the user actually use? Read
// from the transcript, not from buttons — a suggestion counts as used when the
// user's own line soon after it says the same thing (suggestMatch.ts). Pure.

import type { TranscriptSegment } from "../types";
import type { ShownSuggestion } from "./liveSuggest";
import { containment, SAID_IT_THRESHOLD } from "./suggestMatch";

/** A suggestion is only "used" if said within this long of appearing. */
export const ADOPTION_WINDOW_MS = 90_000;

export interface SuggestionOutcome {
  suggestion: ShownSuggestion;
  /** The user's line that used it, or null when none did. */
  saidIn: TranscriptSegment | null;
}

export interface AdoptionReport {
  outcomes: SuggestionOutcome[];
  shown: number;
  used: number;
  /** used / shown, in [0, 1]; null when nothing was shown. */
  rate: number | null;
}

/**
 * Each shown suggestion against the user's own final lines that START within
 * ADOPTION_WINDOW_MS after it appeared (a line already under way when it
 * appeared does not count). A lull card's directions are each their own
 * suggestion. `isSelf` says which lines are the user's (speakers/self.ts).
 * `rate` is null when nothing was shown. Pure.
 */
export function adoptionReport(
  shown: readonly ShownSuggestion[] | undefined,
  segments: readonly TranscriptSegment[],
  isSelf: (s: TranscriptSegment) => boolean,
): AdoptionReport {
  const list = shown ?? [];
  const mine = segments.filter((s) => s.isFinal && s.text.trim() && isSelf(s));
  const outcomes = list.map((suggestion) => {
    const saidIn =
      mine.find(
        (s) =>
          s.startMs >= suggestion.atMs &&
          s.startMs <= suggestion.atMs + ADOPTION_WINDOW_MS &&
          containment(suggestion.text, s.text) >= SAID_IT_THRESHOLD,
      ) ?? null;
    return { suggestion, saidIn };
  });
  const used = outcomes.filter((o) => o.saidIn).length;
  return { outcomes, shown: list.length, used, rate: list.length ? used / list.length : null };
}
