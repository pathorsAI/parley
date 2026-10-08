//
// Shared plumbing for the two 注音 resource generators, `gen-zhuyin-dict.mjs`
// (single characters) and `gen-zhuyin-phrases.mjs` (phrases). Everything here is
// the part that is the same whichever table is being built: where the data comes
// from, how it is pinned, what a valid syllable is.
//
// Source: the McBopomofo project's Traditional Chinese lexicon data.
//   https://github.com/openvanilla/McBopomofo  —  Source/Data/
//   License: MIT (LICENSE.txt at the repository root, "Copyright (c) 2011-2026
//   Mengjuei Hsieh et al."), which covers the data files in that tree.
//
// The three files the generators read:
//   BPMFBase.txt      single character → 注音 reading (McBopomofo's own data)
//   BPMFMappings.txt  phrase → one 注音 reading per character. Their data README
//                     marks it "Originally simplified from tsi.src of libtabe
//                     (BSD Licensed) with modifications", so anything built from
//                     it carries libtabe's BSD notice as well as MIT.
//   phrase.occ        phrase → corpus occurrence count (their frequency corpus)
//
// The download is pinned to a commit rather than taken from a branch, so a
// re-run against an unchanged upstream rewrites a byte-identical file; that
// machinery — and the header block that stamps the commit — lives in
// `resource-data.mjs`, which the English word-list generator shares. Both
// licenses are reproduced in `ios/THIRD-PARTY.md`, which is the file to update
// if a third source appears.
//

import {
  downloadData as downloadPinned,
  provenance as provenanceBlock,
} from "./resource-data.mjs";

/// Where a generated table lives. Re-exported so the two 注音 generators keep
/// importing everything they need from one module.
export { resourcePath } from "./resource-data.mjs";

export const REPO = "openvanilla/McBopomofo";
export const BRANCH = "master";

/** The tone marks 注音 writes as a suffix. First tone carries no mark. */
export const TONES = new Set(["ˊ", "ˇ", "ˋ", "˙"]);
export const INITIALS = "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ";
export const MEDIALS = "ㄧㄨㄩ";
export const FINALS = "ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ";
export const SYMBOLS = new Set([...INITIALS, ...MEDIALS, ...FINALS, ...TONES]);

/// Fetch the McBopomofo data files at one pinned commit — see
/// `resource-data.mjs` for why the download is pinned rather than taken from a
/// branch.
///
/// `MCBOPOMOFO_COMMIT=<sha>` skips resolving the branch and builds from that
/// commit instead. The 注音 resources are read together at runtime — the
/// lattice adds a phrase's score to its characters' — so they must come from
/// one commit; rebuilding one of them after upstream has moved would mix two.
/// Pass the commit the committed headers name unless the point of the run is
/// to take a new upstream, and then rebuild all three.
export function downloadData(files, prefix) {
  return downloadPinned({
    repo: REPO,
    branch: BRANCH,
    commit: process.env.MCBOPOMOFO_COMMIT,
    files,
    prefix,
  });
}

/// The provenance block both 注音 headers end with, with this repository bound.
export function provenance({ script, commit, sources }) {
  return provenanceBlock({ repo: REPO, script, commit, sources });
}

/// `phrase.occ` is `<phrase> <count>`. The dictionary wants only the
/// single-character rows — it commits one syllable at a time — while the phrase
/// generator wants both: phrase rows rank a phrase against its rivals, and
/// character rows are the second half of its score. Hence the predicate.
export function parseOccurrences(text, keep = () => true) {
  const frequency = new Map();
  for (const line of text.split("\n")) {
    const [phrase, count] = line.split(/\s+/);
    if (!phrase || !keep(phrase)) continue;
    frequency.set(phrase, Number(count) || 0);
  }
  return frequency;
}

/// Everything in range is validated rather than trusted: a syllable the keyboard
/// cannot spell would sit in the resource unreachable, so it is an error here
/// instead. `line` is passed only to name the offender.
export function validateSyllable(syllable, line) {
  for (const symbol of syllable) {
    if (!SYMBOLS.has(symbol)) throw new Error(`stray symbol in: ${line}`);
  }
  if (!wellFormed(syllable)) throw new Error(`not a syllable: ${line}`);
}

/// Which slot a symbol occupies. Tone marks — and anything else — land last.
function slot(symbol) {
  if (INITIALS.includes(symbol)) return 0;
  if (MEDIALS.includes(symbol)) return 1;
  if (FINALS.includes(symbol)) return 2;
  return 3;
}

/// The same shape `ZhuyinSyllable` enforces on the Swift side: at most one
/// symbol per slot, in slot order, tone last.
export function wellFormed(reading) {
  let previous = -1;
  for (const c of reading) {
    const s = slot(c);
    if (s <= previous) return false;
    previous = s;
  }
  return true;
}

/// Sort by 注音 symbol order (the Dachen/Unicode order happens to agree) rather
/// than by code point, so a table reads like a rhyme table.
export function compare(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/// McBopomofo's length bonus: a phrase one character longer counts as if the
/// corpus had seen it 2.7 times as often. Their `frequency_builder.py` (MIT)
/// scales every count by `FSCALE ** (length - 1)` before normalising, because a
/// raw count under-rates long phrases against the single characters that could
/// spell them — each of those characters is counted every time it appears in
/// *any* word. Kept at their value so the lattice weighs a phrase against its
/// characters the way their walk does.
export const FSCALE = 2.7;

/// The normaliser every log-probability is taken against: the sum of every
/// `phrase.occ` count, single characters included, each scaled by `FSCALE` for
/// its length — exactly `norm` in McBopomofo's `frequency_builder.py`. One
/// normaliser for both tables is what makes a phrase's score and the sum of its
/// characters' scores comparable, which is the whole question a lattice asks.
export function corpusNorm(frequency) {
  let norm = 0;
  for (const [phrase, count] of frequency) {
    norm += FSCALE ** ([...phrase].length - 1) * count;
  }
  return norm;
}

/// `log10(FSCALE^(length-1) * count / norm)`, McBopomofo's unigram score. A
/// count below one is taken as one half, as theirs is, so a word the corpus
/// never saw still has a finite score rather than minus infinity.
export function log10Probability(count, length, norm) {
  return Math.log10((FSCALE ** (length - 1) * Math.max(count, 0.5)) / norm);
}

/// A score as the resources write it: two decimals of a log10. That is 2% in
/// probability — far finer than anything the lattice decides on — and it keeps
/// the column to five or six bytes a row.
export function formatScore(score) {
  return score.toFixed(2);
}
