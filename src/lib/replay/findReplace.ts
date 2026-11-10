import type { TranscriptSegment } from "../types";

/**
 * Find & replace over a transcript — the pure half of the replay find bar's
 * replace row. No store, no DOM, so every rule is pinned by a unit test.
 *
 * Matching is the find bar's own rule (ReplayTranscript's `matchIds` and
 * `highlightMatches`): a case-insensitive substring match, so what lights up is
 * exactly what gets replaced. Every occurrence in a line is replaced and the
 * rest of the line is left as it was. Occurrences don't overlap: after a match
 * the scan resumes past it, the same way the highlighter walks the text.
 */

/** Start offsets of every non-overlapping, case-insensitive `query` in `text`. */
export function findOccurrences(text: string, query: string): number[] {
  if (!query || !text) return [];
  const q = query.toLowerCase();
  const out: number[] = [];
  // Compared slice by slice rather than by indexing into `text.toLowerCase()`:
  // a few characters (İ) change length when lowercased, which would shift every
  // offset after them and replace the wrong span.
  for (let at = 0; at + query.length <= text.length; ) {
    if (text.slice(at, at + query.length).toLowerCase() === q) {
      out.push(at);
      at += query.length;
    } else {
      at += 1;
    }
  }
  return out;
}

/** How many times `query` occurs in `text` (see {@link findOccurrences}). */
export function countOccurrences(text: string, query: string): number {
  return findOccurrences(text, query).length;
}

/**
 * Replace every occurrence of `query` in `text`. `count` is how many
 * occurrences actually CHANGED — one already spelled exactly like the
 * replacement (a case-insensitive match of "parley" → "Parley" that already
 * reads "Parley") is not a replacement.
 */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
): { text: string; count: number } {
  const hits = findOccurrences(text, query);
  if (hits.length === 0) return { text, count: 0 };
  let out = "";
  let from = 0;
  let count = 0;
  for (const at of hits) {
    const found = text.slice(at, at + query.length);
    out += text.slice(from, at) + replacement;
    if (found !== replacement) count += 1;
    from = at + query.length;
  }
  out += text.slice(from);
  return count === 0 ? { text, count: 0 } : { text: out, count };
}

/**
 * Replace `query` with `replacement` across a transcript — every segment, or
 * only `onlySegmentId` (the find bar's "replace this one", which works on the
 * current matching LINE). Returns the input array itself when nothing changed
 * (empty query, replacement identical to the query, no hits), so a caller can
 * skip the store update and the disk write by identity.
 */
export function replaceInSegments(
  segments: TranscriptSegment[],
  query: string,
  replacement: string,
  opts: { onlySegmentId?: string } = {},
): { segments: TranscriptSegment[]; count: number } {
  if (!query || query === replacement) return { segments, count: 0 };
  let count = 0;
  const next = segments.map((s) => {
    if (opts.onlySegmentId !== undefined && s.id !== opts.onlySegmentId) return s;
    const r = replaceInText(s.text, query, replacement);
    if (r.count === 0) return s;
    count += r.count;
    return { ...s, text: r.text };
  });
  return count === 0 ? { segments, count: 0 } : { segments: next, count };
}

/**
 * Fold edited segment TEXT onto another copy of the same transcript, by segment
 * id. Only `text` moves: timing, speakers and every other field stay as they
 * are in `current` — which is what lets a replace on a recording whose timing
 * is only an on-screen estimate (replay/timing) write back onto the untimed
 * transcript on disk, and keeps a speaker correction that landed in between.
 * Returns `current` itself when nothing changes.
 */
export function foldSegmentTexts(
  current: TranscriptSegment[],
  edited: readonly TranscriptSegment[],
): TranscriptSegment[] {
  const textById = new Map(edited.map((s) => [s.id, s.text]));
  let changed = false;
  const next = current.map((s) => {
    const text = textById.get(s.id);
    if (text === undefined || text === s.text) return s;
    changed = true;
    return { ...s, text };
  });
  return changed ? next : current;
}
