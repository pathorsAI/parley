// Editing the loaded recording's transcript text: the replay find bar's
// replace, end to end — store, saved entry, and the dictionary nudge after.

import { useStore } from "../store";
import { log } from "../log";
import { addEntry, whenDictionaryReady, type AddResult } from "../dictionary";
import { persistTranscriptText } from "../history/history";
import { replaceInSegments } from "./findReplace";

/**
 * Replace `query` with `replacement` in the loaded recording's transcript —
 * every line, or only `onlySegmentId` — and persist it. Returns how many
 * occurrences changed (0 = nothing happened, nothing written).
 *
 * The store takes the new text at once; the saved entry follows in the
 * background through {@link persistTranscriptText}. A not-yet-saved upload has
 * no entry yet — its first save snapshots the store, edited text included. A
 * read-only org recording is refused outright: the UI never offers replace
 * there, and its text belongs to someone else.
 */
export function replaceInTranscript(
  query: string,
  replacement: string,
  opts: { onlySegmentId?: string } = {},
): number {
  const s = useStore.getState();
  if (!s.replay || s.replayReadOnly) return 0;
  const { segments, count } = replaceInSegments(s.segments, query, replacement, opts);
  if (count === 0) return 0;
  s.applyTranscriptEdit(segments);
  log.info("replay: transcript text replaced", { count, single: opts.onlySegmentId !== undefined });
  const id = s.loadedHistoryId;
  if (id) {
    persistTranscriptText(id, segments).catch((e) =>
      log.error("replay: transcript edit save failed", { id, error: String(e) }),
    );
  }
  return count;
}

/**
 * Teach the dictionary the word a replace just fixed: `to` becomes a term,
 * with the misheard `from` as a variant — the same shape the speaker-background
 * correction loop learns (onboarding/micCheck `learnTerm`), so the next
 * transcription is biased toward the right spelling AND rewrites the old one.
 * Already known (same phrase, same variant) → nothing is added, and the result
 * is null.
 */
export async function teachReplacement(from: string, to: string): Promise<AddResult | null> {
  await whenDictionaryReady();
  const variant = from.trim();
  return addEntry({
    phrase: to,
    // A case-only fix takes no variant: the phrase itself biases the spelling,
    // and a variant equal to it but for case would only fight it.
    variants: variant && variant.toLowerCase() !== to.trim().toLowerCase() ? [variant] : [],
    source: "correction",
  });
}
