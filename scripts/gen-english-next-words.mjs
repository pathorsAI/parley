#!/usr/bin/env node
//
// Generates the English pane's next-word table:
// `ios/ParleyKit/Sources/ParleyKit/Resources/english-next-words.txt`.
//
// This is what lets the English pane offer a word before a letter of it is
// typed: after `thank ` the bar already offers `you`, the way the system
// QWERTY's predictive bar does. The same table tells `WordSuggestions` that
// `thankyou` is two words run together, because `thank you` is a known pair.
//
// ## Source and license
//
//   https://github.com/orgtre/google-books-ngram-frequency — `ngrams/2grams_english.csv`
//
// The 5,000 most frequent English 2-grams of Google Books Ngram v3
// (20200217), counted over books from 2010-2019 and cleaned. Its README
// states: "The content of this repository is licensed under the Creative
// Commons Attribution 3.0 Unported License." Google's Books Ngram datasets are
// CC-BY 3.0 themselves. Attribution-only, like the word list's source, and the
// credit is in `ios/THIRD-PARTY.md`.
//
// The download is pinned to a commit and the commit is stamped into the output
// header; see `resource-data.mjs`.
//
// Regenerate:
//   node scripts/gen-english-next-words.mjs
//
// Output format: after a `#` comment header, one line per previous word,
// `prev next1 next2 ...`, space-separated. `prev` is lowercase; each follower
// keeps its own display case (`I`, `York`), best first.
//
// ## What is kept
//
//   * Pairs of two letter-only tokens. Google's tokenizer splits contractions
//     into fragments (`I 'm`, `do n't`), and a fragment is not a word the bar
//     can offer.
//   * Case-insensitively merged. `The same` and `the same` are one pair with
//     the counts summed; a follower is shown in the casing of its
//     highest-count variant, so `I` and `York` keep their capitals and `first`
//     stays lowercase.
//   * The top SUGGESTION_LIMIT followers per previous word, by summed count,
//     upstream order as the tiebreak. Lines are ordered by the previous word's
//     first appearance upstream, so the output is reproducible.

import { writeFile } from "node:fs/promises";

import { downloadData, provenance, resourcePath } from "./resource-data.mjs";

const REPO = "orgtre/google-books-ngram-frequency";
const BRANCH = "main";
const FILES = ["ngrams/2grams_english.csv"];

const SUGGESTION_LIMIT = 5;

const OUT = resourcePath("english-next-words.txt");

async function main() {
  const { commit, texts } = await downloadData({
    repo: REPO,
    branch: BRANCH,
    files: FILES,
    prefix: "english-next-words-",
  });

  const pairs = parseBigrams(texts[0]);
  const byPrevious = group(pairs);

  const header = [
    "# English next-word table for the keyboard's suggestion bar: after",
    "#   `thank ` the bar offers `you`, and `thankyou` is offered as `thank you`.",
    "# One line per previous word: `prev next1 next2 ...`, space-separated, prev",
    "#   lowercase, followers in display case, most frequent first.",
    ...provenance({
      repo: REPO,
      script: "gen-english-next-words.mjs",
      commit,
      sources: [
        "#   ngrams/2grams_english.csv, the 5,000 most frequent English 2-grams of",
        "#   Google Books Ngram v3 (books 2010-2019). CC-BY 3.0 (the repository's",
        "#   content, and the Google Books Ngram corpus it is derived from).",
      ],
    }),
  ];
  const lines = [...byPrevious].map(
    ([previous, followers]) => [previous, ...followers].join(" ")
  );
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const bytes = Buffer.byteLength([...header, ...lines].join("\n"), "utf8");
  console.log(
    `${OUT}\n  ${lines.length} lines, ${pairs.length} pairs, ` +
      `${(bytes / 1024).toFixed(0)} KiB`
  );
}

/// Upstream is `ngram,freq` with a header row and no quoting.
function parseBigrams(text) {
  const byPair = new Map();
  const rows = text.split("\n").slice(1);
  for (const [position, line] of rows.entries()) {
    const [ngram, freq] = line.trim().split(",");
    if (!ngram || !freq) continue;
    const tokens = ngram.split(" ");
    if (tokens.length !== 2 || !tokens.every((t) => /^[A-Za-z]+$/.test(t))) continue;
    const [previous, next] = tokens;
    const count = Number(freq);
    const key = `${previous.toLowerCase()} ${next.toLowerCase()}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, {
        previous: previous.toLowerCase(),
        next,
        nextCount: count,
        count,
        position,
      });
      continue;
    }
    existing.count += count;
    if (count > existing.nextCount) {
      existing.next = next;
      existing.nextCount = count;
    }
  }
  return [...byPair.values()];
}

function group(pairs) {
  const byPrevious = new Map();
  for (const pair of [...pairs].sort((a, b) => a.position - b.position)) {
    if (!byPrevious.has(pair.previous)) byPrevious.set(pair.previous, []);
    byPrevious.get(pair.previous).push(pair);
  }
  const out = new Map();
  for (const [previous, followers] of byPrevious) {
    followers.sort((a, b) => b.count - a.count || a.position - b.position);
    out.set(previous, followers.slice(0, SUGGESTION_LIMIT).map((pair) => pair.next));
  }
  return out;
}

await main();
