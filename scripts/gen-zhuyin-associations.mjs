#!/usr/bin/env node
//
// Generates the 注音 keyboard's associated-phrase table (聯想詞):
// `ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-associations.txt`.
//
// After a candidate is picked and nothing is left to type, the strip offers
// what usually comes next: pick 研 and it offers 究, 發, 判 …; pick 究 from
// there and it offers what follows 研究. That is McBopomofo's associated
// phrases, and this table is built the way their `associated-phrases-v2.txt`
// is (`Source/Data/curation/builders/phrase_deriver.py`, MIT): every phrase is
// filed under its first character, the bucket is sorted by score, best first,
// and cut at a fixed number per prefix. Their file is a build product — it is
// derived from their cooked `data.txt` and is not in their repository — so
// this derives it again from the same inputs the phrase table is built from,
// scored by the same `scoredRows`, rather than running their Python pipeline.
//
// Two differences from theirs, both about the keyboard rather than the data:
//
//   * Filed under the **character**, not the (character, reading) pair. Their
//     v2 key carries the reading because their candidate window knows which
//     reading a character was typed with. This strip follows a commit, and a
//     commit can be a phrase, a prediction or a forgiven match, so the reading
//     is not reliably known — the character always is.
//   * Only phrases the corpus actually counted. The phrase table keeps every
//     zero-count two-character phrase so a typed reading can still find a word
//     the corpus is too old for (see `gen-zhuyin-phrases.mjs`); a suggestion
//     nobody typed for is a different bargain, and an unseen phrase is a poor
//     guess at what comes next.
//
// Regenerate (same commit as the other two 注音 resources — see
// `downloadData` in `zhuyin-data.mjs`):
//   MCBOPOMOFO_COMMIT=<sha> node scripts/gen-zhuyin-associations.mjs
//
// Output format, one row per first character, sorted by character:
//   <character>\t<continuation> <continuation> …
// where a continuation is the phrase with its first character removed, best
// first. A continuation never contains a space, so the row needs no escaping.
// `ZhuyinAssociations` also reads a row for the longer suffix of what was just
// committed — after 研究 it looks for rows under 研 whose continuation starts
// with 究 — so `PER_CHARACTER` bounds that too.

import { writeFile } from "node:fs/promises";

import { scoredRows } from "./gen-zhuyin-phrases.mjs";
import { compare, downloadData, provenance, resourcePath } from "./zhuyin-data.mjs";

const FILES = ["Source/Data/BPMFMappings.txt", "Source/Data/phrase.occ"];

/// McBopomofo's `MAX_ENTRIES_PER_PREFIX`. The strip draws at most thirty
/// (`StripBar.drawnLimit`); the rest are there for the longer-suffix lookups,
/// which filter a bucket rather than take its head.
const PER_CHARACTER = 60;

const OUT = resourcePath("zhuyin-associations.txt");

async function main() {
  const { commit, texts } = await downloadData(FILES, "zhuyin-associations-");
  const { kept } = scoredRows(texts);

  // `kept` is already in score order, best first. A phrase listed under two
  // readings is one association.
  const buckets = new Map();
  const seen = new Set();
  for (const row of kept) {
    if (row.count === 0 || seen.has(row.phrase)) continue;
    seen.add(row.phrase);
    const [first, ...rest] = [...row.phrase];
    if (!buckets.has(first)) buckets.set(first, []);
    const bucket = buckets.get(first);
    if (bucket.length < PER_CHARACTER) bucket.push(rest.join(""));
  }

  const header = [
    "# 注音 associated phrases (聯想詞): what usually follows a committed character.",
    String.raw`# One row per first character: <character>\t<continuations, space separated>,`,
    "#   best first. A continuation is the phrase without its first character.",
    ...provenance({
      script: "gen-zhuyin-associations.mjs",
      commit,
      sources: [
        "#   Source/Data/BPMFMappings.txt + Source/Data/phrase.occ, derived the way",
        "#   McBopomofo derives associated-phrases-v2.txt. MIT (McBopomofo), and BSD",
        "#   (libtabe) for the phrases BPMFMappings.txt was simplified from.",
      ],
    }),
  ];
  const lines = [...buckets.keys()]
    .sort(compare)
    .map((first) => `${first}\t${buckets.get(first).join(" ")}`);
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const continuations = [...buckets.values()].reduce((n, b) => n + b.length, 0);
  const bytes = Buffer.byteLength(lines.join("\n"), "utf8");
  console.log(
    `${OUT}\n  ${lines.length} characters, ${continuations} continuations, ${(
      bytes / 1024
    ).toFixed(0)} KiB`
  );
}

await main();
