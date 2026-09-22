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
// **Why a commit rather than a branch.** Each generator resolves the default
// branch to a commit, downloads from that commit, and stamps it into the output
// header. Re-running against an unchanged upstream therefore rewrites a
// byte-identical file, and a real upstream change shows up as a reviewable diff
// naming the commit it came from. Both licenses are reproduced in
// `ios/THIRD-PARTY.md`, which is the file to update if a third source appears.
//

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "openvanilla/McBopomofo";
export const BRANCH = "master";

/** The tone marks 注音 writes as a suffix. First tone carries no mark. */
export const TONES = new Set(["ˊ", "ˇ", "ˋ", "˙"]);
export const INITIALS = "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ";
export const MEDIALS = "ㄧㄨㄩ";
export const FINALS = "ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ";
export const SYMBOLS = new Set([...INITIALS, ...MEDIALS, ...FINALS, ...TONES]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/// Where a generated table lives, so neither generator has to know the layout.
export function resourcePath(name) {
  return join(root, "ios/ParleyKit/Sources/ParleyKit/Resources", name);
}

/// Resolve the branch, then fetch every file at that one commit. Returns the
/// commit so the caller can stamp it into its header — see the note above on
/// why the download is pinned.
export async function downloadData(files, prefix) {
  const commit = await resolveCommit();
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const texts = await Promise.all(
    files.map((path) => download(commit, path, dir))
  );
  return { commit, texts };
}

async function resolveCommit() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/commits/${BRANCH}`,
    { headers: { accept: "application/vnd.github.sha" } }
  );
  if (!res.ok) throw new Error(`resolving ${BRANCH}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function download(commit, path, dir) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const file = join(dir, path.replaceAll("/", "_"));
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return readFile(file, "utf8");
}

/// The provenance block both headers end with: what rebuilds the file, which
/// commit it came from, the per-generator license lines, and where the notices
/// are kept.
export function provenance({ script, commit, sources }) {
  return [
    `# GENERATED — run scripts/${script} to rebuild; do not hand-edit.`,
    `# Source: https://github.com/${REPO} @ ${commit}`,
    ...sources,
    "# See ios/THIRD-PARTY.md.",
  ];
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
