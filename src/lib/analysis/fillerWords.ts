//! Hardcoded filler-word / verbal-crutch vocabulary used by the delivery
//! analysis to spot OVER-USE. This is the single place to tune detection — add
//! or remove entries here and the live + post-call delivery passes pick them up.
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
//! to include here: they're only ever flagged when genuinely overused.

/** Per-language lexical filler vocabulary. Keyed by AppLanguage plus extras. */
export const FILLER_WORDS: Record<string, string[]> = {
  "zh-TW": [
    "那個",
    "這個",
    "就是",
    "就是說",
    "然後",
    "反正",
    "其實",
    "基本上",
    "怎麼講",
    "怎麼說",
    "你知道",
    "你知道嗎",
    "你懂嗎",
    "對不對",
    "對啊對啊",
    "這樣子",
    "之類的",
    "什麼的",
    "老實說",
    "說真的",
    "的部分",
    "的話",
  ],
  en: [
    "like",
    "you know",
    "i mean",
    "basically",
    "actually",
    "literally",
    "sort of",
    "kind of",
    "kinda",
    "sorta",
    "you see",
    "i guess",
    "right?",
    "so yeah",
    "to be honest",
    "at the end of the day",
    "or whatever",
    "and stuff",
  ],
};

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

const FILLER_SOUND_PATTERNS: RegExp[] = [
  // Latin hesitations: um/umm, uh/uhh, uhm, er/err, erm, hmm, mm(m), ah, eh.
  // Both word boundaries keep them from matching inside real words (human,
  // yeah, ahead…).
  /\b(?:u+m+|u+h+|uh+m+|e+r+m*|erm|h+m+|m+m+|a+h+|e+h+)\b/gi,
  // Runs of unambiguous CJK hesitation characters.
  new RegExp(`[${CJK_FILLER_CHARS}]+`, "gu"),
  // Repeated ambiguous CJK particles only (啊啊 / 喔喔喔).
  new RegExp(`([${CJK_PARTICLE_CHARS}])\\1+`, "gu"),
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
