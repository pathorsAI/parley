#!/usr/bin/env node
//
// Generates the English pane's word list:
// `ios/ParleyKit/Sources/ParleyKit/Resources/english-words.txt`.
//
// This is what lets the English pane complete a word instead of making the user
// spell it: typing `tomo` has to already offer `tomorrow`, the way the system
// QWERTY's predictive bar does. `EnglishWords` reads the file, keeps each row's
// position as its rank, and offers the lowest-ranked words that start with what
// was typed.
//
// ## Source and license
//
//   https://github.com/hackerb9/gwordlist — `frequency-alpha-alldicts.txt`
//
// The 246,591 alphabetic words of Google's Books Ngram corpus that could be
// verified against a dictionary (GCIDE/Webster's 1913, WordNet, OED v2), sorted
// by corpus frequency. Its README states the terms plainly: the *programs* in
// that repository are GPL, and **the data is released under Creative Commons
// Attribution 3.0** — "the same license as Google granted me", Google's Books
// Ngram datasets being CC-BY 3.0 themselves. CC-BY is attribution-only, with no
// share-alike and no non-commercial clause, so it can ship inside a proprietary
// binary as long as it is credited; the credit is in `ios/THIRD-PARTY.md`.
//
// Lists that were considered and rejected for licensing, so nobody re-litigates
// this: Norvig's `count_1w` (derived from LDC corpora, terms unclear),
// hermitdave/FrequencyWords (CC-BY-**SA**), SUBTLEX (non-commercial),
// google-10000-english (LDC-derived).
//
// The download is pinned to a commit and the commit is stamped into the output
// header — see `resource-data.mjs`, shared with the 注音 generators.
//
// Regenerate:
//   node scripts/gen-english-words.mjs
//
// Output format: one lowercase word per line, most frequent first, after a `#`
// comment header. **The loader relies on that order**: rank is the line's
// position and nothing else.
//
// ## What is kept, and why it is not everything
//
//   * Lowercased. Upstream lists each word once, under its most frequent
//     capitalization, carrying the total count for every case — so `Hello` is
//     the row for `hello`, and lowercasing is a rename rather than a merge.
//     Proper nouns come along in lower case, which is right for this use: the
//     pane capitalises a suggestion when the partial was capitalised, so typing
//     `Lond` offers `London` and typing `lond` offers `london`.
//   * Letters only, 2–20 characters. Single letters are dropped except `a` and
//     `i`, which are words; a one-letter partial has nothing to complete anyway,
//     but they are the two that can be *offered*.
//   * The top KEEP rows and no more. The whole list is 246,591 words and 2.4 MB,
//     and the tail of it is taxonomy and OCR debris (`ambulacral`,
//     `manganiferous`) that no phone keyboard will ever offer. 40,000 is where
//     the list still reads like English — and this runs inside a keyboard
//     extension, the process iOS jetsams first.
//
// ## The supplement, and why a frequency list needs one
//
// The corpus is *books*, scanned from 1880 onward, so it has two blind spots a
// keyboard cannot live with. It has **no contractions at all** — Google's
// tokenizer splits `can't` into `can not` — and it is too old for a handful of
// everyday words (`app`, `wifi`, `emoji`). SUPPLEMENT adds those by hand, each
// scored as if the corpus had seen it SUPPLEMENT_COUNT times, which lands them
// among the common words without putting them above them. This is the same
// device, for the same reason, as `CONVERSATIONAL` in `gen-zhuyin-phrases.mjs`:
// a short hand-written list that only ever moves a word up.

import { writeFile } from "node:fs/promises";

import { downloadData, provenance, resourcePath } from "./resource-data.mjs";

const REPO = "hackerb9/gwordlist";
const BRANCH = "master";
const FILES = ["frequency-alpha-alldicts.txt"];

/// How many words the resource keeps. See the note above on where 40,000 comes
/// from; it is a size-and-quality decision, not a property of the data.
const KEEP = 40_000;

/// Length bounds. Two because a one-letter partial has nothing to complete;
/// twenty because past that a bar cannot show the word anyway.
const MIN_LENGTH = 2;
const MAX_LENGTH = 20;

/// The one-letter words English actually has. Everything else of length one in
/// the corpus is an initial, a unit or an OCR artefact.
const SINGLE_LETTER_WORDS = ["a", "i"];

/// The synthetic corpus count a supplement word is scored with. 50 million is
/// the count at about rank 3,000 in this corpus — common company, not the head
/// of the list.
const SUPPLEMENT_COUNT = 50_000_000;

/// Words the corpus cannot supply. Contractions first — Google's tokenizer
/// splits every one of them, so there is not a single apostrophe in 246,591
/// rows — then the words a corpus of books from 1880 onward is simply too old
/// for. Kept short on purpose: every entry here is a claim about frequency that
/// nothing measured.
const SUPPLEMENT = [
  "i'm", "i'll", "i've", "i'd", "it's", "that's", "there's", "here's",
  "what's", "let's", "he's", "she's", "we're", "you're", "they're", "we've",
  "you've", "they've", "we'll", "you'll", "they'll", "he'll", "she'll",
  "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't",
  "shouldn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't",
  "hadn't", "ain't",
  "app", "apps", "email", "emails", "emoji", "online", "offline", "internet",
  "website", "download", "upload", "login", "smartphone", "laptop", "wifi",
  "username", "password", "podcast", "blog", "selfie", "browser", "startup",
  "okay", "ok", "hi", "hey", "thanks", "bye", "yeah", "yep", "nope", "sorry",
];

const OUT = resourcePath("english-words.txt");

async function main() {
  const { commit, texts } = await downloadData({
    repo: REPO,
    branch: BRANCH,
    files: FILES,
    prefix: "english-words-",
  });

  const rows = merge(parseFrequencies(texts[0]), SUPPLEMENT);
  // Count first, upstream order as the tiebreak — the same rule the 注音
  // generators use, and for the same reason: a stable tiebreak is what makes
  // the output reproducible. The supplement's rows all carry one count, so
  // they fall among themselves in the order they are written above.
  rows.sort((a, b) => b.count - a.count || a.rank - b.rank);
  const kept = rows.slice(0, KEEP);

  const header = [
    "# English word list for the keyboard's suggestion bar: typing `tomo`",
    "#   already offers `tomorrow`.",
    "# One lowercase word per line, most frequent first — the reader keeps file",
    "#   order and has no counts of its own.",
    "# Contractions and a few words a corpus of books is too old for are added",
    "#   by the generator; see it for the list.",
    ...provenance({
      repo: REPO,
      script: "gen-english-words.mjs",
      commit,
      sources: [
        "#   frequency-alpha-alldicts.txt, derived from the Google Books Ngram",
        "#   corpus. CC-BY 3.0 (the repository's README grants the data under the",
        "#   same terms Google grants the corpus).",
      ],
    }),
  ];
  const lines = kept.map((row) => row.word);
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const bytes = Buffer.byteLength([...header, ...lines].join("\n"), "utf8");
  console.log(
    `${OUT}\n  ${lines.length} words, ${(bytes / 1024).toFixed(0)} KiB, ` +
      `of ${rows.length} candidates (${SUPPLEMENT.length} supplied by hand)`
  );
}

/// Upstream is a fixed-width table, `<rank> <word> <count> <percent>
/// <cumulative>`, with a `#RANKING` header line and thousands separators in the
/// counts. Rows that are not words this keyboard can offer are skipped rather
/// than rejected: the file is a corpus dump and is expected to contain plenty.
function parseFrequencies(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [, word, count] = line.trim().split(/\s+/);
    if (!word || !count) continue;
    const lowered = word.toLowerCase();
    if (!acceptable(lowered)) continue;
    rows.push({ word: lowered, count: Number(count.replaceAll(",", "")) || 0 });
  }
  return rows;
}

/// A word the pane could offer: letters only, in range, and not a stray
/// initial. Upstream's "alpha" lists carry no apostrophes at all, so the check
/// is deliberately ASCII letters and nothing else — the supplement is where
/// apostrophes come from, and it does not go through here.
function acceptable(word) {
  if (!/^[a-z]+$/.test(word)) return false;
  if (word.length > MAX_LENGTH) return false;
  if (word.length >= MIN_LENGTH) return true;
  return SINGLE_LETTER_WORDS.includes(word);
}

/// One row per word, supplement included, each carrying the rank that breaks
/// ties. A supplement word the corpus already has keeps whichever count is
/// higher — the point of the list is to lift words, never to demote one.
function merge(corpus, supplement) {
  const byWord = new Map();
  for (const row of corpus) {
    const existing = byWord.get(row.word);
    // Upstream lists each word once. If a future revision ever lists two
    // capitalizations separately, the larger count is the honest one to keep.
    if (existing) existing.count = Math.max(existing.count, row.count);
    else byWord.set(row.word, { ...row, rank: byWord.size });
  }
  for (const word of supplement) {
    const existing = byWord.get(word);
    if (existing) existing.count = Math.max(existing.count, SUPPLEMENT_COUNT);
    else byWord.set(word, { word, count: SUPPLEMENT_COUNT, rank: byWord.size });
  }
  return [...byWord.values()];
}

await main();
