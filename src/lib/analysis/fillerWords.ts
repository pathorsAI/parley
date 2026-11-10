//! Filler-word / verbal-crutch vocabulary used by the delivery analysis to spot
//! OVER-use. The lists live in shared/prompts/study.json (`fillerWords`) — the
//! single place to tune detection, shared with Android; the live + post-call
//! delivery passes on every client pick changes up from there.
//!
//! DELIBERATELY LEXICAL words/phrases only — NOT non-lexical hesitation sounds
//! (um, uh, er, 呃, 啊, 嗯, 喔). Speech-to-text engines routinely drop those, so
//! trying to detect them is unreliable; we only track real words that actually
//! land in the transcript.
//!
//! Detection never flags mere presence — everyone uses these. The analysis flags
//! a speaker only when they lean on these densely enough to distract (the LLM
//! judges over-use vs. ordinary meaningful use; see analyzeDelivery). That keeps
//! borderline entries (e.g. 其實 / "actually", which are often meaningful) safe
//! to include: they're only ever flagged when genuinely overused.

import { STUDY } from "../ai/studyPrompt";

/** Per-language lexical filler vocabulary. Keyed by AppLanguage plus extras. */
export const FILLER_WORDS: Record<string, string[]> = STUDY.fillerWords;

/**
 * Flat, de-duplicated watchlist for a given UI language. Includes the other
 * language's list too, since speakers commonly code-switch (English crutch words
 * slip into Mandarin speech and vice-versa). The UI language is listed first.
 */
export function fillerWatchlist(language: string): string[] {
  const own = language.startsWith("zh") ? FILLER_WORDS["zh-TW"] : FILLER_WORDS.en;
  const other = language.startsWith("zh") ? FILLER_WORDS.en : FILLER_WORDS["zh-TW"];
  return Array.from(new Set([...own, ...other]));
}

// ── Non-lexical filler SOUNDS ("um" / "uh" / "嗯" / "呃") ──────────────────────
// Unlike the lexical crutch words above (which the LLM judges for over-use), the
// hesitation NOISES are matched directly against the live transcript so the
// delivery panel can tally them in real time — the acoustic DSP detector missed
// too many, so we count whatever the recognizer actually wrote down.
//
// GLOBAL on purpose (not per-language): speech-to-text renders the same
// hesitation inconsistently across locales — a Mandarin "嗯 / 呃" is frequently
// transcribed as "um" / "uh" — so one cross-language map catches them however
// the engine tagged the audio. Runs collapse to a single event ("嗯嗯" and
// "ummm" each count once).

/** Unambiguous Mandarin hesitation characters — a run of these is always filler. */
const CJK_FILLER_CHARS = "嗯唔呃痾疴欸誒呣";
/** Particles that only read as hesitation when repeated (啊啊 / 喔喔), since a
 *  single one is almost always a meaningful sentence particle. */
const CJK_PARTICLE_CHARS = "啊喔哦呀";

// Latin hesitations, one simple shape per entry: um/umm, uh/uhh, uhm, er/erm,
// hmm, mm(m), ah, eh. Kept as separate patterns instead of one giant
// alternation so no single regex has the ambiguous/overlapping quantifiers that
// risk super-linear backtracking. Every shape is `\b`-anchored to a whole word
// (so they never match inside real words like human, yeah, ahead…) and the
// shapes use disjoint letter sets, so a given word matches at most one shape —
// counting them independently can never double-count. (`e+r+m*` already covers
// "erm", so no standalone "erm" entry is needed.)
const LATIN_FILLER_SHAPES = [
  "u+m+", // um, umm, ummm
  "u+h+", // uh, uhh
  "uh+m+", // uhm, uhhm, uhmm
  "e+r+m*", // er, err, erm, ermm
  "h+m+", // hm, hmm
  "m+m+", // mm, mmm
  "a+h+", // ah, ahh
  "e+h+", // eh, ehh
];

const FILLER_SOUND_PATTERNS: RegExp[] = [
  ...LATIN_FILLER_SHAPES.map(
    (shape) => new RegExp(String.raw`\b(?:${shape})\b`, "gi"),
  ),
  // Runs of unambiguous CJK hesitation characters.
  new RegExp(`[${CJK_FILLER_CHARS}]+`, "gu"),
  // Repeated ambiguous CJK particles only (啊啊 / 喔喔喔).
  new RegExp(String.raw`([${CJK_PARTICLE_CHARS}])\1+`, "gu"),
];

/**
 * Count non-lexical filler SOUND events in a transcript fragment. Language
 * agnostic; repeated runs count once. Used to tally hesitations live as segments
 * stream in (see the store's `upsertSegment`).
 */
export function countFillerSounds(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const re of FILLER_SOUND_PATTERNS) {
    re.lastIndex = 0;
    while (re.exec(text) !== null) count += 1;
  }
  return count;
}

// ── Per-word filler tally (the post-meeting 評分 view) ─────────────────────────
// The scorecard lists WHICH fillers you leaned on, not just how many — "然後 ×6",
// "對對對 ×3" — so this tallies three families per normalized label:
//   • the lexical crutch words from the shared vocabulary (both languages, since
//     speakers code-switch), longest entry first so 就是說 never also counts 就是;
//   • the non-lexical hesitation sounds above, folded to one label per shape
//     ("ummm" → um, "嗯嗯" → 嗯) so variants pile onto the same chip;
//   • rapid-fire agreement runs (對對對) — a crutch that is in neither list,
//     because a single 對 is an answer, not a filler.
// Unlike the LLM pass this never judges over-use; it is a plain count.

/** Canonical chip label per Latin hesitation shape, index-aligned with
 *  LATIN_FILLER_SHAPES. */
const LATIN_FILLER_LABELS = ["um", "uh", "uhm", "er", "hmm", "mm", "ah", "eh"];

/** Rapid-fire agreement: three or more 對 in a row (spaces / commas allowed
 *  between them). Two (對對) reads as an ordinary confirmation. */
const AGREEMENT_RUN = /對(?:[\s,，、]*對){2,}/gu;
const AGREEMENT_LABEL = "對對對";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const HAS_LATIN = /[a-z]/i;
const WORD_CHAR = /[a-z0-9']/i;

/** One alternation over every lexical filler, longest first so the regex engine
 *  prefers 就是說 over 就是 and "you know" over "you". CJK entries have no
 *  spaces to anchor to, so they match as substrings; Latin ones are checked for
 *  word boundaries afterwards (see lexicalLabel). */
const LEXICAL_FILLER_PATTERN: RegExp = (() => {
  const words = Array.from(
    new Set([...(FILLER_WORDS["zh-TW"] ?? []), ...(FILLER_WORDS.en ?? [])].map((w) => w.toLowerCase())),
  ).sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${words.map(escapeRegExp).join("|")})`, "giu");
})();

/** The label for a lexical match, or null when a Latin entry sits inside a
 *  longer word ("like" in "likely"). Checked by hand rather than with a
 *  lookbehind, which older WebKit builds reject at parse time. */
function lexicalLabel(m: RegExpExecArray, text: string): string | null {
  const word = m[0];
  if (HAS_LATIN.test(word)) {
    const before = text[m.index - 1] ?? "";
    const after = text[m.index + word.length] ?? "";
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) return null;
  }
  return word.toLowerCase();
}

/** Fold a hesitation-sound match to its chip label. */
function soundLabel(patternIndex: number, match: string): string {
  if (patternIndex < LATIN_FILLER_LABELS.length) return LATIN_FILLER_LABELS[patternIndex];
  // CJK runs: the first character names it (嗯嗯嗯 → 嗯); a repeated particle
  // keeps its doubled form (啊啊), since a single 啊 is not a filler.
  const first = Array.from(match)[0] ?? match;
  return patternIndex === LATIN_FILLER_LABELS.length ? first : first + first;
}

function bump(into: Map<string, number>, label: string): void {
  into.set(label, (into.get(label) ?? 0) + 1);
}

/** Run a global regex over `text`, bumping the label each match maps to (a null
 *  label skips the match). */
function tallyMatches(
  re: RegExp,
  text: string,
  label: (m: RegExpExecArray) => string | null,
  into: Map<string, number>,
): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const l = label(m);
    if (l) bump(into, l);
  }
}

/**
 * Tally every filler in a transcript fragment by label — lexical crutch words,
 * hesitation sounds, and agreement runs (see above). Adds into `into` when given,
 * so a caller can fold a whole transcript into one map.
 */
export function countFillersByWord(text: string, into: Map<string, number> = new Map()): Map<string, number> {
  if (!text) return into;
  FILLER_SOUND_PATTERNS.forEach((re, i) => tallyMatches(re, text, (m) => soundLabel(i, m[0]), into));
  tallyMatches(AGREEMENT_RUN, text, () => AGREEMENT_LABEL, into);
  tallyMatches(LEXICAL_FILLER_PATTERN, text, (m) => lexicalLabel(m, text), into);
  return into;
}

/** A filler label and how often it came up. */
export interface FillerCount {
  word: string;
  count: number;
}

/** The `limit` most frequent fillers, most frequent first (ties: longer label
 *  first, then alphabetical, so the order is stable across renders). */
export function topFillers(counts: Map<string, number>, limit = 5): FillerCount[] {
  return Array.from(counts, ([word, count]) => ({ word, count }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || a.word.localeCompare(b.word))
    .slice(0, limit);
}
