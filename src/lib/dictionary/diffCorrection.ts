//! Turn "the user fixed a word right after we pasted" into a dictionary
//! candidate.
//!
//! Rust watches the field Parley just pasted into and, once its value settles,
//! reports the before/after pair. Everything interesting is in the middle: strip
//! what both strings share at the front and at the back, and whatever is left is
//! the edit. The rest of this file is about refusing the edits that AREN'T a
//! misheard word — insertions, deletions, and wholesale rewrites all reach us
//! through the same channel, and offering to "learn" one of those would poison
//! the dictionary.

/** Longest a side of the correction may be. A dictionary term is a name or a
 *  short phrase; anything longer is the user rewriting their sentence. */
const MAX_TERM_LENGTH = 24;
/** Below this, the pasted text is too short to reason about. */
const MIN_INSERTED_LENGTH = 2;
/** Replacing more than this share of what we pasted is a rewrite, not a fix. */
const REWRITE_RATIO = 0.4;
/** Fewest code points either side of a pair may have once either side is
 *  non-ASCII. The diff below strips everything the two strings share, so
 *  fixing one character of a two-character name (小名 → 小明) leaves exactly
 *  that one character on each side — and a learned 名 → 明 is a GLOBAL
 *  substring rewrite: every later 名字 becomes 明字, 報名 becomes 報明. Now that
 *  every window applies a new entry the moment it is written, that corruption
 *  would start with the very next dictation. The same goes for 一 → 1: a lone
 *  digit matches as a whole word between CJK characters. A real fix of one
 *  character of a known term still learns, widened by the anchors. */
const MIN_CJK_TERM = 2;

const WORD_CHAR = /\w/;
const ASCII_ONLY = /^[\x00-\x7F]*$/;

function isWord(cp: string | undefined): boolean {
  return !!cp && WORD_CHAR.test(cp);
}

/**
 * The one word-level edit between `baseline` and `current`, or null when the
 * change isn't a correction of the text we pasted.
 *
 * Both strings are walked as CODE POINTS, never UTF-16 units, so a shared emoji
 * prefix can't be sliced through the middle of a surrogate pair (which would
 * hand back a lone surrogate as "the misheard word").
 *
 * `insertedText` is what Parley pasted. The edit must land inside it — the
 * field may hold text the user wrote before or after, and their unrelated typing
 * elsewhere is none of our business.
 *
 * `anchors` are whole terms the user is known to write (their profile name and
 * company, the dictionary's phrases — `recognitionTerms`). CJK has no word
 * boundaries for the diff to widen to, so a one-character fix inside a name
 * would otherwise be learned as that single character. When the corrected text
 * has an anchor covering the whole edit, the pair is widened to the full term
 * on both sides (王小名 → 王小明): the text around the edit is shared by
 * construction, so the "from" side is the same span as it stood before. An
 * anchored edit is a term fix by definition, so the rewrite-ratio check is
 * skipped — "我是小名" → "我是小明" must still learn, though the term is half of
 * that short paste.
 */
export function detectCorrection(
  baseline: string,
  current: string,
  insertedText: string,
  anchors: readonly string[] = [],
): { from: string; to: string } | null {
  if (baseline === current) return null;

  const a = [...baseline];
  const b = [...current];
  let { start, endA, endB } = editSpan(a, b);
  const anchor = anchorAround(b, start, endB, anchors);
  if (anchor) {
    endA += anchor.end - endB;
    endB = anchor.end;
    start = anchor.start;
  }

  const from = a.slice(start, endA).join("").trim();
  const to = b.slice(start, endB).join("").trim();

  // Pure insertion or deletion at a non-word boundary: there's no "this became
  // that" pair to learn.
  if (!from || !to) return null;
  if (from === to) return null;
  if (from.length > MAX_TERM_LENGTH || to.length > MAX_TERM_LENGTH) return null;
  if (insertedText.length < MIN_INSERTED_LENGTH) return null;
  // The correction has to target what we pasted, not something the user had
  // already typed in that field.
  if (!insertedText.includes(from)) return null;
  if (!anchor && from.length > REWRITE_RATIO * insertedText.length) return null;
  // Applies to anchored pairs too: a character inserted into a known term
  // (明 → 小明) widens to a one-character "from", and "from" is the side that
  // gets rewritten everywhere.
  const nonAscii = !ASCII_ONLY.test(from) || !ASCII_ONLY.test(to);
  if (nonAscii && ([...from].length < MIN_CJK_TERM || [...to].length < MIN_CJK_TERM)) {
    return null;
  }

  return { from, to };
}

/**
 * The longest anchor occurrence in `b` (code points) that covers the whole
 * edited span `[start, endB)` — and actually overlaps it, so a pure deletion
 * right next to a term is not mistaken for a fix of that term. Anchors shorter
 * than {@link MIN_CJK_TERM} or longer than {@link MAX_TERM_LENGTH} code points
 * are not considered: the first would reintroduce the single-character pair,
 * the second could never pass the length check anyway.
 */
function anchorAround(
  b: readonly string[],
  start: number,
  endB: number,
  anchors: readonly string[],
): { start: number; end: number } | null {
  const terms = anchors
    .map((t) => [...t.trim()])
    .filter((t) => t.length >= MIN_CJK_TERM && t.length <= MAX_TERM_LENGTH)
    .sort((x, y) => y.length - x.length);
  for (const term of terms) {
    // Only an occurrence starting in [endB - term.length, start] can cover the
    // span, so that is the whole search window.
    const first = Math.max(0, endB - term.length);
    for (let s = first; s <= start; s++) {
      const e = s + term.length;
      if (e > b.length) break;
      if (e < endB || !(s < endB && e > start)) continue;
      if (term.every((cp, i) => b[s + i] === cp)) return { start: s, end: e };
    }
  }
  return null;
}

/**
 * The one stretch where `a` and `b` differ: the shared prefix stripped off the
 * front, the shared suffix off the back.
 *
 * Those boundaries happily stop mid-word: editing "Parle" into "Parley" shares
 * everything but the trailing "y", which on its own reads as a pure insertion.
 * When a boundary cuts an ASCII word, push it out to the word's edge so the
 * pair becomes the whole word on each side.
 */
function editSpan(
  a: readonly string[],
  b: readonly string[],
): { start: number; endA: number; endB: number } {
  const max = Math.min(a.length, b.length);

  let start = 0;
  while (start < max && a[start] === b[start]) start++;
  let suffix = 0;
  while (suffix < max - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  let endA = a.length - suffix;
  let endB = b.length - suffix;

  if (cutsWordAtStart(a, b, start, endA, endB)) {
    while (start > 0 && isWord(a[start - 1])) start--;
  }
  if (cutsWordAtEnd(a, b, start, endA, endB)) {
    while (endA < a.length && endB < b.length && isWord(a[endA])) {
      endA++;
      endB++;
    }
  }

  return { start, endA, endB };
}

/** True when the leading boundary sits inside an ASCII word: the shared char
 *  before it is a word char, and at least one side continues with one. */
function cutsWordAtStart(
  a: readonly string[],
  b: readonly string[],
  start: number,
  endA: number,
  endB: number,
): boolean {
  if (start === 0 || !isWord(a[start - 1])) return false;
  return (start < endA && isWord(a[start])) || (start < endB && isWord(b[start]));
}

/** Mirror of {@link cutsWordAtStart} for the trailing boundary. */
function cutsWordAtEnd(
  a: readonly string[],
  b: readonly string[],
  start: number,
  endA: number,
  endB: number,
): boolean {
  if (endA >= a.length || !isWord(a[endA])) return false;
  return (endA > start && isWord(a[endA - 1])) || (endB > start && isWord(b[endB - 1]));
}
