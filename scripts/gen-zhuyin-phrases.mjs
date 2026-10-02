#!/usr/bin/env node
//
// Generates the 注音 keyboard's phrase table:
// `ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-phrases.txt`.
//
// Sibling of `gen-zhuyin-dict.mjs`, which builds the single-character table.
// This one is what lets the pane predict: typing `ㄋㄏ` — two lone 聲母 — has to
// already offer 你好, the way the system 注音 keyboard does, and no amount of
// per-syllable data can answer that. It needs a phrase lexicon.
//
// Where the data comes from, why the download is pinned to a commit, and the
// **two licenses** the phrase readings carry — MIT for McBopomofo, BSD for the
// libtabe `tsi.src` their `BPMFMappings.txt` was simplified from — are all
// written up once in `zhuyin-data.mjs`, which both generators share. This one
// reads `BPMFMappings.txt` (phrase → one reading per character, a phrase
// repeated once per alternative reading) and `phrase.occ` (corpus counts).
//
// Regenerate:
//   node scripts/gen-zhuyin-phrases.mjs
//
// Output format, one row per line:
//   <phrase>\t<syllable> <syllable> …\t<log10 probability>
// tone marks written, first tone bare, sorted by SCORE descending, ties broken
// by McBopomofo's own file order. **The loader relies on that order**:
// `ZhuyinPhrases` keeps each row's position and offers matches in file order,
// which is therefore rank order, so the bar never sorts by the third column.
//
// The third column is for the lattice (`ZhuyinComposer.best`), which has to
// weigh a phrase against the characters that could spell it — a question rank
// cannot answer, because rank only compares phrases with each other. It is the
// same SCORE, moved onto McBopomofo's scale: see `logProbability`.
//
// The score is not the raw count, because the corpus is written news and this
// keyboard types messages. Two corrections, both in `score()`:
//
//   * the phrase's own count is damped (a log) and added to the mean of its
//     characters' counts (logs too), so a phrase made of everyday characters
//     ranks above a rare compound the corpus happened to print more often.
//     Measured on the data: ㄨㄕ puts 我是 first rather than third.
//   * the words in CONVERSATIONAL are scored as if the corpus had seen them
//     3,000 times. 你好 is a greeting; a news corpus barely contains it (121
//     occurrences, behind 女孩 and 內涵), and a user typing ㄋㄏ means the
//     greeting. The list is short, hand-written and only ever moves a word up.
//
// What is kept, and why it is not everything:
//
//   * 2–4 characters. 5- and 6-character entries are idioms and titles; they
//     cost rows that the candidate bar — which shows a handful — would never
//     reach, and the buffer is six syllables anyway.
//   * occurrence count >= MIN_OCCURRENCES — after the conversational floor, so
//     a word on that list is never dropped — plus **every** 2-character phrase
//     the corpus never saw at all. Keeping each of the 101,932 phrases with a
//     non-zero count would be 3.1 MB and 102k rows inside a keyboard extension,
//     which is the process iOS jetsams first; the threshold is where that lands
//     under ~2 MB. The zero-count 2-character phrases are kept whole rather
//     than truncated because McBopomofo's file order is by reading, so a prefix
//     of them would be an alphabetical slice rather than a useful sample — and
//     a 2-character word missing from the corpus is usually a word the corpus
//     is too old for, which is exactly what prediction is for.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  corpusNorm,
  downloadData,
  formatScore,
  log10Probability,
  parseOccurrences,
  provenance,
  resourcePath,
  validateSyllable,
} from "./zhuyin-data.mjs";

const FILES = ["Source/Data/BPMFMappings.txt", "Source/Data/phrase.occ"];

/// The corpus count below which a phrase is dropped. Ten rather than one is a
/// size decision, not a quality claim — see the note above.
const MIN_OCCURRENCES = 10;
/// Longest phrase kept. Also the longest prediction `ZhuyinComposer.best` will
/// take in one step.
const MAX_LENGTH = 4;

/// Everyday words a news corpus under-counts, scored as if it had seen them
/// this often. The number is a rank, not a measurement: 3,000 puts a word among
/// the common ones without putting it above them all.
const CONVERSATIONAL_OCCURRENCES = 3000;

/// The words themselves. This keyboard is for messages — greetings, replies,
/// apologies, the small change of a conversation — and those are exactly the
/// words a corpus of published writing has least of. Everything here is a word
/// a person types at somebody, never a topic they write about.
const CONVERSATIONAL = new Set([
  "你好", "您好", "謝謝", "請問", "不好意思", "對不起", "沒問題", "沒關係",
  "好的", "好啊", "可以", "我們", "你們", "他們", "什麼", "怎麼", "為什麼",
  "現在", "今天", "明天", "昨天", "知道", "覺得", "這個", "那個", "一下",
  "一起", "等等", "再見", "晚安", "早安", "麻煩", "收到", "好像", "應該",
  "可能", "已經", "還是", "但是", "因為", "所以", "如果", "然後", "就是",
  "這樣", "真的", "有沒有", "是不是", "要不要", "沒有", "不是", "不要",
  "不用", "不會", "好嗎", "你好嗎", "辛苦了", "拜託", "加油", "恭喜",
  "抱歉", "了解",
]);

const OUT = resourcePath("zhuyin-phrases.txt");

async function main() {
  const { commit, texts } = await downloadData(FILES, "zhuyin-phrases-");
  const { rows, kept } = scoredRows(texts);

  const header = [
    "# 注音 phrase candidates — the table that lets the pane predict from the",
    "#   first symbol of each syllable: ㄋㄏ already offers 你好.",
    "# One row per (phrase, reading) pair:",
    String.raw`#   <phrase>\t<syllables, space separated>\t<log10 probability>.`,
    "# Ordered by score, most likely first — the bar keeps file order; the third",
    "#   column only weighs a phrase against the characters that would spell it.",
    ...provenance({
      script: "gen-zhuyin-phrases.mjs",
      commit,
      sources: [
        "#   Source/Data/BPMFMappings.txt + Source/Data/phrase.occ. MIT (McBopomofo),",
        "#   and BSD (libtabe) for the readings BPMFMappings.txt was simplified from.",
      ],
    }),
  ];
  const lines = kept.map(
    (row) => `${row.phrase}\t${row.reading}\t${formatScore(row.logProbability)}`
  );
  await writeFile(OUT, `${[...header, ...lines].join("\n")}\n`, "utf8");

  const bytes = Buffer.byteLength([...header, ...lines].join("\n"), "utf8");
  const zero = kept.filter((row) => row.count === 0).length;
  console.log(
    `${OUT}\n  ${lines.length} rows (${
      lines.length - zero
    } with count >= ${MIN_OCCURRENCES}, ${zero} two-character with no count), ${
      (bytes / 1024 / 1024).toFixed(2)
    } MiB, of ${rows.length} candidate rows upstream`
  );
}

/// Parse, score and filter the two upstream files, in resource order. Shared
/// with `gen-zhuyin-associations.mjs`, whose next-phrase table has to rank
/// phrases exactly the way this one does.
///
/// Every row of `phrase.occ` is wanted here, single characters included: the
/// phrase rows rank a phrase against its rivals, and the character rows are
/// the second half of `score`. One-character *rows* are never written to the
/// resource — that is the dictionary's job — but their counts are read.
export function scoredRows([mappings, occ]) {
  const frequency = parseOccurrences(occ);
  const rows = parseMappings(mappings);
  for (const row of rows) {
    row.count = countOf(row.phrase, frequency);
    row.score = score(row, frequency);
  }

  const kept = rows.filter(keep);
  // Score first, file order as the tiebreak — the same rule the dictionary
  // generator uses, and for the same reason: a stable tiebreak is what makes
  // the output reproducible. The zero-count rows fall to the end on their own.
  kept.sort((a, b) => b.score - a.score || a.rank - b.rank);

  const norm = corpusNorm(frequency);
  const pivot = characterPivot(kept, frequency);
  for (const row of kept) row.logProbability = logProbability(row, pivot, norm);
  return { rows, kept, frequency, norm };
}

/// SCORE moved onto McBopomofo's log10 scale, so a phrase can be weighed
/// against the single characters that would spell it (their scores come from
/// `gen-zhuyin-dict.mjs`, against the same `norm`).
///
/// SCORE is `ln(count + 1) + characters`, where `characters` is the mean
/// `ln(charCount + 1)` of the phrase's characters. Read backwards, that is the
/// log of a pseudo-count, `(count + 1) * e^characters` — the phrase's own count
/// scaled up or down by how ordinary its characters are. `pivot` is the
/// `characters` of a typical phrase, so dividing by `e^pivot` leaves a phrase of
/// typical characters with its own count, and moves the rest by the very amount
/// SCORE already moved them. Then McBopomofo's `log10(2.7^(len-1) * count /
/// norm)` (`log10Probability`).
///
/// Monotone in SCORE for a given length, which is the property that matters:
/// among phrases of one length — all the lattice ever compares for one span —
/// the highest-scoring is the first in file order, so the walk and the bar can
/// never disagree about which phrase answers a span. A zero-count row keeps its
/// place too: its pseudo-count is `e^(characters - pivot)`, about McBopomofo's
/// own one half for typical characters.
function logProbability(row, pivot, norm) {
  const pseudo = Math.exp(row.score - pivot);
  return log10Probability(pseudo, row.length, norm);
}

/// The median `characters` term over the rows the corpus actually counted —
/// what a typical phrase's characters are worth. The median rather than the
/// mean so the conversational floor and the handful of enormous counts cannot
/// pull it.
function characterPivot(kept, frequency) {
  const terms = kept
    .filter((row) => row.count > 0)
    .map((row) => characterTerm(row.phrase, frequency))
    .sort((a, b) => a - b);
  return terms[Math.floor(terms.length / 2)] ?? 0;
}

/// The mean `ln(charCount + 1)` of a phrase's characters — the second half of
/// `score`.
function characterTerm(phrase, frequency) {
  let total = 0;
  let length = 0;
  for (const character of phrase) {
    total += Math.log((frequency.get(character) ?? 0) + 1);
    length += 1;
  }
  return total / length;
}

/// A phrase listed with several readings shares one count: the corpus counted
/// the characters, which is all it can see. The conversational floor is applied
/// here, before anything filters on the count, so a word on that list is never
/// dropped for being rare in the news.
function countOf(phrase, frequency) {
  const counted = frequency.get(phrase) ?? 0;
  if (!CONVERSATIONAL.has(phrase)) return counted;
  return Math.max(counted, CONVERSATIONAL_OCCURRENCES);
}

/// Common enough to earn its row, or one of the 2-character phrases the corpus
/// never saw at all — see the note at the top on why those are kept whole.
function keep(row) {
  if (row.count >= MIN_OCCURRENCES) return true;
  return row.count === 0 && row.length === 2;
}

/// How a row is ranked: the phrase's own count, damped, plus how ordinary its
/// characters are. Both halves are logs, which is what keeps a phrase the
/// corpus printed 50,000 times from burying one it printed 500 times — the gap
/// between those two is far smaller in a message than in a newspaper — and the
/// character term is what lifts a plain phrase like 我是 above a rarer compound
/// with the same reading.
function score(row, frequency) {
  return Math.log(row.count + 1) + characterTerm(row.phrase, frequency);
}

/// `BPMFMappings.txt` is `<phrase> <syllable> <syllable> …`, one reading per
/// character, repeated for a phrase with more than one reading.
function parseMappings(text) {
  const rows = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const row = parseRow(line);
    if (!row) continue;
    // A phrase listed twice with the same reading would be shown twice in the
    // bar; upstream has none today, and this is what keeps it that way.
    const key = `${row.phrase}\t${row.reading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, rank: rows.length });
  }
  return rows;
}

/// One line of `BPMFMappings.txt`, or null for a line this table has no use for.
///
/// Everything in range is validated rather than trusted: a row the keyboard
/// could never type — a syllable it cannot spell, a character that is more than
/// one Unicode scalar, a reading that doesn't have one syllable per character —
/// would sit in the resource unreachable, so it is an error here instead. Rows
/// outside 2..MAX_LENGTH are *skipped*, which is a size decision and not a
/// complaint about the data.
function parseRow(line) {
  if (!line.trim() || line.startsWith("#")) return null;
  const [phrase, ...syllables] = line.trim().split(/\s+/);
  const characters = [...phrase];
  if (characters.length < 2 || characters.length > MAX_LENGTH) return null;
  if (characters.length !== syllables.length) {
    throw new Error(`one reading per character, please: ${line}`);
  }
  for (const syllable of syllables) validateSyllable(syllable, line);
  return { phrase, reading: syllables.join(" "), length: characters.length };
}

// Run only when executed, not when `gen-zhuyin-associations.mjs` imports
// `scoredRows` from here.
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
