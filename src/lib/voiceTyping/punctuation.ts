//! Pause-made full stops → commas, for dictation.
//!
//! The streaming recognizer runs with endpoint detection on, and closes every
//! endpointed utterance with a sentence-final mark. So every breath-length
//! pause ends a "sentence": a dictation of one thought comes back as 我覺得。 這個方案。 可以。 — short
//! fragments, each with its own 。 and, in the bilingual zh/en mode, a stray
//! ASCII space after it. The LLM polish repunctuates and fixes that, but only
//! when it runs: it is optional, it skips anything shorter than
//! MIN_POLISH_CHARS or of a single clause, it falls back to the raw text when
//! it times out or fails, and the overlay's live preview never sees its
//! output. This pass is the floor
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


const HAN = /\p{Script=Han}/u;
/** What counts toward a sentence's length: letters (Han included) and digits. */
const CONTENT = /[\p{L}\p{N}]/u;
const FULLWIDTH_MARKS = new Set(["。", "，", "、", "；", "：", "？", "！"]);
const SENTENCE_ENDS = new Set(["。", "？", "！", "?", "!", "\n"]);
/** Any mark that splits a dictation into clauses (or sentences, or lines). */
const CLAUSE_MARK = /[。，、；：？！,.?!;:\n]/u;
/** One sentence-final mark a single clause may end with. */
const FINAL_MARK = /[。？！.?!]$/u;
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

/** 好的。 → 好的, 我等一下就過去。 → 我等一下就過去: a dictation of one clause
 *  is a phrase, not a sentence, whatever its length. ？ and ！ are always kept;
 *  they carry meaning a 。 does not. */
function dropBarePhraseStop(s: string): string {
  if (!s.endsWith("。")) return s;
  const body = s.slice(0, -1);
  return CLAUSE_MARK.test(body) ? s : body;
}

/**
 * Whether a dictation is a single clause: no comma, stop or any other mark
 * anywhere but, optionally, one sentence-final mark at its very end. Said in
 * one breath it is a reply, a name, a search term or a quick "我等一下就過去" —
 * there is nothing in it for the polish pass to restructure, so the host
 * skips that round trip (polish.ts, `polishSkipReason`). Run it on the
 * softened text: softening never removes a mark between clauses (a pause-made
 * 。 becomes ，), so a dictation of several breaths is never one clause.
 */
export function isSingleClause(text: string): boolean {
  const body = text.trim().replace(FINAL_MARK, "");
  return CONTENT.test(body) && !CLAUSE_MARK.test(body);
}
