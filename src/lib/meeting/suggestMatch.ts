// How close a spoken line is to a suggested one. Character bigrams work the
// same for Chinese (no word boundaries) and English, need no model, and are
// cheap enough to run on every final line. Pure.

/** Lowercased letters, digits and CJK only: punctuation, spaces and fillers'
 *  separators do not make two lines different. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): Map<string, number> {
  const s = normalizeForMatch(text);
  const out = new Map<string, number>();
  if (s.length === 1) out.set(s, 1);
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * How much of `suggestion` shows up in `spoken`: the share of the
 * suggestion's bigrams the spoken line also has, in [0, 1]. Containment, not
 * Jaccard, because a suggestion said inside a longer sentence ("對，我想問一下，
 * 晚上沒接到的電話一個月大概多少通？") is still the suggestion said.
 */
export function containment(suggestion: string, spoken: string): number {
  const a = bigrams(suggestion);
  if (a.size === 0) return 0;
  const b = bigrams(spoken);
  let total = 0;
  let shared = 0;
  for (const [g, n] of a) {
    total += n;
    shared += Math.min(n, b.get(g) ?? 0);
  }
  return total ? shared / total : 0;
}

/** At or above this, the user said the suggestion (in their own words, near
 *  enough). Tuned on paraphrases, not exact reads: people never read it as is. */
export const SAID_IT_THRESHOLD = 0.35;
