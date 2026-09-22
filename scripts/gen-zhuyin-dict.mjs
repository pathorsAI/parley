#!/usr/bin/env node
//
// Generates the 注音 keyboard's candidate dictionary:
// `ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-dict.txt`.
//
// Where the data comes from, why the download is pinned to a commit, and what
// each upstream file is: see `zhuyin-data.mjs`, which both generators share.
// This one reads `BPMFBase.txt` (single character → reading) and `phrase.occ`
// (corpus counts).
//
// `BPMFMappings.txt`, their multi-character phrase file, belongs to the other
// generator: `gen-zhuyin-phrases.mjs` builds the phrase table from it. It is
// kept out of this one because it carries a second license's provenance —
// their README marks it as simplified from libtabe's `tsi.src` — and because
// the two resources are loaded independently at runtime.
//
// Regenerate:
//   node scripts/gen-zhuyin-dict.mjs
//
// Output format, one row per line, sorted by key:
//   <reading>\t<candidates>     a reading *with* its tone mark
//   ~<reading>\t<candidates>    the same reading with no tone at all
// where `candidates` is the characters concatenated with no separator, most
// frequent first. Every character in the source is exactly one Unicode scalar,
// so the reader splits on scalars rather than parsing — see `ZhuyinDictionary`.
//
// The `~` rows are what the pane shows while a syllable is still being typed:
// the native 注音 keyboard segments a run of toneless symbols and offers
// candidates before any tone key is pressed. They need a prefix rather than a
// key of their own because **the first tone is written with no mark**, so
// `ㄋㄧ` already means ㄋㄧˉ and cannot double as "ㄋㄧ, tone unknown". Each `~`
// row is the union of that reading's five tone rows, deduped by character.

import { writeFile } from "node:fs/promises";

import {
  TONES,
  compare,
  downloadData,
  parseOccurrences,
  provenance,
  resourcePath,
  validateSyllable,
} from "./zhuyin-data.mjs";

const FILES = ["Source/Data/BPMFBase.txt", "Source/Data/phrase.occ"];

const OUT = resourcePath("zhuyin-dict.txt");

async function main() {
  const { commit, texts } = await downloadData(FILES, "zhuyin-");
  const [base, occ] = texts;

  // Only the single-character rows are of any use here — v1 commits one
  // syllable at a time.
  const frequency = parseOccurrences(occ, (phrase) => [...phrase].length === 1);
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

  // Toneless rows, after the toned ones so the first half of the file stays a
  // plain rhyme table. A character read with several tones appears once, at the
  // rank of its first appearance — the merged row is still ordered by corpus
  // frequency, which is what the bar wants.
  const toneless = new Map();
  for (const [reading, entries] of readings) {
    const key = [...reading].filter((c) => !TONES.has(c)).join("");
    if (!toneless.has(key)) toneless.set(key, new Map());
    const merged = toneless.get(key);
    for (const { char, rank } of entries) {
      const seen = merged.get(char);
      if (seen === undefined || rank < seen) merged.set(char, rank);
    }
  }
  for (const key of [...toneless.keys()].sort(compare)) {
    const chars = [...toneless.get(key)].sort(
      ([aChar, aRank], [bChar, bRank]) =>
        (frequency.get(bChar) ?? 0) - (frequency.get(aChar) ?? 0) ||
        aRank - bRank
    );
    lines.push(`~${key}\t${chars.map(([char]) => char).join("")}`);
  }

  const header = [
    "# 注音 single-character candidates, most frequent first.",
    "# A `~` key is the toneless lookup for that reading — every character across",
    "#   its five tones, deduped — because the first tone is written with no mark",
    "#   and so cannot also stand for \"tone not typed yet\".",
    ...provenance({
      script: "gen-zhuyin-dict.mjs",
      commit,
      sources: [
        "#   Source/Data/BPMFBase.txt + Source/Data/phrase.occ, MIT licensed.",
      ],
    }),
  ];
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const chars = lines.reduce((n, l) => n + [...l.split("\t")[1]].length, 0);
  console.log(
    `${OUT}\n  ${lines.length - toneless.size} syllables + ${
      toneless.size
    } toneless, ${chars} characters, ${
      Buffer.byteLength(lines.join("\n"), "utf8") / 1024 | 0
    } KiB`
  );
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
    validateSyllable(reading, line);
    // Their file also maps the tone marks to themselves (`ˊ ˊ`), which is a
    // reading the keyboard can never produce — a tone with an empty buffer does
    // nothing. Dropping them keeps every line in the resource reachable.
    if ([...reading].every((c) => TONES.has(c))) continue;
    if (!readings.has(reading)) readings.set(reading, []);
    readings.get(reading).push({ char, rank: rank++ });
  }
  return readings;
}

await main();
