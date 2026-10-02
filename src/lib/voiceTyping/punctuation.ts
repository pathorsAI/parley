//! Pause-made full stops → commas, for dictation.
//!
//! The hosted STT (Soniox, behind the "parley" provider) runs with endpoint
//! detection on, and the model closes every endpointed utterance with a
//! sentence-final mark. So every breath-length pause ends a "sentence": a
//! dictation of one thought comes back as 我覺得。 這個方案。 可以。 — short
//! fragments, each with its own 。 and, in the bilingual zh/en mode, a stray
//! ASCII space after it. The LLM polish repunctuates from scratch and fixes
//! that, but only when it runs: it is optional, it skips anything shorter than
//! MIN_POLISH_CHARS, it falls back to the raw text when it times out or fails,
//! and the overlay's live preview never sees its output. This pass is the floor
//! under it: deterministic, offline, zero latency, applied to the text the
//! overlay shows, which is also what the host copies, pastes, polishes and
//! saves.
//!
//! Only the full-width 。 is ever rewritten (plus the space that follows any
//! full-width mark, whose width already carries one). ASCII text — English
//! sentences, decimals, URLs — is never touched, so the pass is safe for every
//! STT provider and every language.
//!
//! The decision for each mark depends only on the text before it plus the one
//! character after it, so as the live tail grows, earlier text never changes;
//! only the trailing mark can still flip (。 → ， once the next fragment
//! arrives).
//!
//! No imports on purpose: this is bundled into the overlay window, and polish.ts
//! (where MIN_POLISH_CHARS lives) pulls in the AI SDK.

/** A pause-made 。 becomes ， until the running sentence holds this many content
 *  characters; the first pause after that keeps its 。 and starts a new sentence.
 *  32: on real dictation history this halves the full stops (582 → 314) and moves
 *  the median sentence from 18 to 37 characters (p90 48 → 66). */
export const SOFT_SENTENCE_CHARS = 32;

/** A whole dictation this short with no other punctuation is a phrase (a reply, a
 *  name, a search term), and its trailing 。 is dropped. Content characters, so a
 *  7-character phrase with its 。 is 8 UTF-16 units: right AT polish.ts's
 *  MIN_POLISH_CHARS (8), not below it. Dropping that 。 (or the space after a
 *  full-width mark) must not also switch polish off, so the host measures the
 *  gate on the text before this pass (`TranscriptText.sttText`), and polish runs
 *  on exactly what it ran on before. Not imported, to keep the AI SDK out of the
 *  overlay bundle. Set to 0 to keep the 。 on every phrase. */
export const BARE_PHRASE_MAX_CHARS = 7;

const HAN = /\p{Script=Han}/u;
/** What counts toward a sentence's length: letters (Han included) and digits. */
const CONTENT = /[\p{L}\p{N}]/u;
const FULLWIDTH_MARKS = new Set(["。", "，", "、", "；", "：", "？", "！"]);
const SENTENCE_ENDS = new Set(["。", "？", "！", "?", "!", "\n"]);
const ANY_MARK = /[。，、；：？！,.?!;:]/u;
/** Horizontal whitespace a full-width mark absorbs: space, tab, no-break space. */
const HSPACE = new Set([" ", "\t", "\u00a0"]);

/**
 * Rewrites the full stops a pause produced into commas, so a dictation reads
 * as sentences of a natural length instead of one per breath, and drops the
 * trailing 。 of a bare short phrase. Pure and idempotent; never adds, removes
 * or reorders a letter or digit.
 */
export function softenPausePeriods(text: string): string {
  const chars = Array.from(text);
  let out = "";
  let run = 0; // content chars since the last sentence end that was KEPT
  for (let i = 0; i < chars.length; ) {
    let c = chars[i];
    if (FULLWIDTH_MARKS.has(c)) {
      let j = i + 1;
      while (j < chars.length && HSPACE.has(chars[j])) j++;
      if (c === "。" && isPauseStop(chars[i - 1], chars[j])) {
        if (run < SOFT_SENTENCE_CHARS) c = "，"; // a breath, not a sentence end: the run continues
        else run = 0;
      } else if (SENTENCE_ENDS.has(c)) {
        run = 0;
      }
      out += c;
      i = j; // a full-width mark carries its own spacing: drop the ASCII space after it
      continue;
    }
    if (SENTENCE_ENDS.has(c)) run = 0;
    else if (CONTENT.test(c)) run++;
    out += c;
    i++;
  }
  return dropBarePhraseStop(out);
}

/** A 。 between two clauses: a letter/digit/Han right before it (so 。。。, 」。 and
 *  a leading 。 are left alone) and a Han character next (so 。OK, 。3, 。\n and the
 *  final mark are left alone). */
function isPauseStop(prev: string | undefined, next: string | undefined): boolean {
  return prev !== undefined && CONTENT.test(prev) && next !== undefined && HAN.test(next);
}

/** 好的。 → 好的: a short dictation with no other punctuation is a phrase, not a
 *  sentence. ？ and ！ are always kept; they carry meaning a 。 does not. */
function dropBarePhraseStop(s: string): string {
  if (!s.endsWith("。")) return s;
  const body = s.slice(0, -1);
  if (ANY_MARK.test(body)) return s;
  let n = 0;
  for (const ch of body) if (CONTENT.test(ch)) n++;
  return n <= BARE_PHRASE_MAX_CHARS ? body : s;
}
