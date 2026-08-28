#!/usr/bin/env node
//
// Generates the 注音 keyboard's candidate dictionary:
// `ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-dict.txt`.
//
// Source: the McBopomofo project's Traditional Chinese lexicon data.
//   https://github.com/openvanilla/McBopomofo  —  Source/Data/
//   License: MIT (LICENSE.txt at the repository root, "Copyright (c) 2011-2026
//   Mengjuei Hsieh et al."), which covers the data files in that tree.
//
// Two files are read, both MIT:
//   BPMFBase.txt  single character → 注音 reading (McBopomofo's own data)
//   phrase.occ    phrase → corpus occurrence count (their frequency corpus)
//
// `BPMFMappings.txt` is deliberately **not** used. It is the file their README
// marks as simplified from libtabe's `tsi.src`, so it carries a second
// license's provenance — and it is multi-character phrases, which v1 of the
// pane does not do anyway (see docs/design/ios-voice-keyboard.md).
//
// Regenerate:
//   node scripts/gen-zhuyin-dict.mjs
//
// It downloads from the pinned default branch, stamps the resolved commit into
// the output header, and rewrites the resource in place — so re-running it on
// an unchanged upstream produces a byte-identical file, and a real upstream
// change shows up as a diff with the commit it came from.
//
// Output format, one syllable per line, sorted by syllable:
//   <reading>\t<candidates>
// where `candidates` is the characters for that reading concatenated with no
// separator, most frequent first. Every character in the source is exactly one
// Unicode scalar, so the reader splits on scalars rather than parsing — see
// `ZhuyinDictionary`.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "openvanilla/McBopomofo";
const BRANCH = "master";
const FILES = ["Source/Data/BPMFBase.txt", "Source/Data/phrase.occ"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(
  root,
  "ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-dict.txt"
);

/** The tone marks 注音 writes as a suffix. First tone carries no mark. */
const TONES = new Set(["ˊ", "ˇ", "ˋ", "˙"]);
const INITIALS = "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ";
const MEDIALS = "ㄧㄨㄩ";
const FINALS = "ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ";
const SYMBOLS = new Set([...INITIALS, ...MEDIALS, ...FINALS, ...TONES]);

async function main() {
  const commit = await resolveCommit();
  const dir = await mkdtemp(join(tmpdir(), "zhuyin-"));
  const [base, occ] = await Promise.all(
    FILES.map((path) => download(commit, path, dir))
  );

  const frequency = parseOccurrences(occ);
  const readings = parseBase(base);

  // Frequency first, then the order McBopomofo lists them in, which is their
  // editors' own rough commonness ranking — a stable tiebreak matters more than
  // which one wins, because it is what makes the output reproducible.
  const lines = [];
  for (const reading of [...readings.keys()].sort(compare)) {
    const entries = readings.get(reading);
    entries.sort(
      (a, b) =>
        (frequency.get(b.char) ?? 0) - (frequency.get(a.char) ?? 0) ||
        a.rank - b.rank
    );
    lines.push(`${reading}\t${entries.map((e) => e.char).join("")}`);
  }

  const header = [
    "# 注音 single-character candidates, most frequent first.",
    "# GENERATED — run scripts/gen-zhuyin-dict.mjs to rebuild; do not hand-edit.",
    `# Source: https://github.com/${REPO} @ ${commit}`,
    "#   Source/Data/BPMFBase.txt + Source/Data/phrase.occ, MIT licensed.",
    "# See ios/THIRD-PARTY.md.",
  ];
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const chars = lines.reduce((n, l) => n + [...l.split("\t")[1]].length, 0);
  console.log(
    `${OUT}\n  ${lines.length} syllables, ${chars} characters, ${
      Buffer.byteLength(lines.join("\n"), "utf8") / 1024 | 0
    } KiB`
  );
}

/// Pin the download to a commit rather than a moving branch, so the header can
/// name exactly what the committed resource was built from.
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

/// `phrase.occ` is `<phrase> <count>`. Only single characters are of any use
/// here — v1 commits one syllable at a time.
function parseOccurrences(text) {
  const frequency = new Map();
  for (const line of text.split("\n")) {
    const [phrase, count] = line.split(/\s+/);
    if (!phrase || [...phrase].length !== 1) continue;
    frequency.set(phrase, Number(count) || 0);
  }
  return frequency;
}

/// `BPMFBase.txt` is `<char> <reading> <pinyin> <dachen-keys> <encoding>`.
/// The reading column is authoritative: four rows in their file have a typo in
/// the Dachen key column (`公 ㄍㄨㄥ˙ … ej/5`), which is exactly why the
/// keyboard's key table is written out in Swift rather than derived from here.
function parseBase(text) {
  const readings = new Map();
  let rank = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [char, reading] = line.split(/\s+/);
    if (!char || !reading) continue;
    if ([...char].length !== 1) throw new Error(`not one character: ${line}`);
    for (const symbol of reading) {
      if (!SYMBOLS.has(symbol)) throw new Error(`stray symbol in: ${line}`);
    }
    if (!wellFormed(reading)) throw new Error(`not a syllable: ${line}`);
    // Their file also maps the tone marks to themselves (`ˊ ˊ`), which is a
    // reading the keyboard can never produce — a tone with an empty buffer does
    // nothing. Dropping them keeps every line in the resource reachable.
    if ([...reading].every((c) => TONES.has(c))) continue;
    if (!readings.has(reading)) readings.set(reading, []);
    readings.get(reading).push({ char, rank: rank++ });
  }
  return readings;
}

/// The same shape `ZhuyinSyllable` enforces on the Swift side: at most one
/// symbol per slot, in slot order, tone last. A source line that doesn't fit is
/// a line the keyboard could never have typed, so it is an error rather than
/// something to drop quietly.
function wellFormed(reading) {
  const slot = (c) =>
    INITIALS.includes(c) ? 0 : MEDIALS.includes(c) ? 1 : FINALS.includes(c) ? 2 : 3;
  let previous = -1;
  for (const c of reading) {
    const s = slot(c);
    if (s <= previous) return false;
    previous = s;
  }
  return true;
}

/// Sort by 注音 symbol order (the Dachen/Unicode order happens to agree) rather
/// than by code point, so the file reads like a rhyme table.
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

await main();
