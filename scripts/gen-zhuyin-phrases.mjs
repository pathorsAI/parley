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
// Source: the McBopomofo project's Traditional Chinese lexicon data.
//   https://github.com/openvanilla/McBopomofo  —  Source/Data/
//   BPMFMappings.txt  phrase → one 注音 reading per character (2–6 characters,
//                     a phrase repeated once per alternative reading)
//   phrase.occ        phrase → corpus occurrence count
//
// **Two licenses.** McBopomofo ships under the MIT license, and their own data
// README marks `BPMFMappings.txt` as "Originally simplified from tsi.src of
// libtabe (BSD Licensed) with modifications" — so the phrase table carries
// libtabe's BSD notice as well. Both are reproduced in `ios/THIRD-PARTY.md`,
// which is the file to update if this ever pulls in a third source.
//
// Regenerate:
//   node scripts/gen-zhuyin-phrases.mjs
//
// Like the dictionary generator it resolves the branch to a commit, downloads
// from that commit, and stamps it into the output header — so re-running it on
// an unchanged upstream rewrites a byte-identical file, and a real upstream
// change shows up as a diff naming the commit it came from.
//
// Output format, one row per line:
//   <phrase>\t<syllable> <syllable> …     tone marks written, first tone bare
// sorted by SCORE descending, ties broken by McBopomofo's own file order.
// **The loader relies on that**: `ZhuyinPhrases` keeps each row's position and
// offers matches in file order, which is therefore rank order, so the table
// carries no scores of its own.
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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "openvanilla/McBopomofo";
const BRANCH = "master";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(
  root,
  "ios/ParleyKit/Sources/ParleyKit/Resources/zhuyin-phrases.txt"
);

/** The tone marks 注音 writes as a suffix. First tone carries no mark. */
const TONES = new Set(["ˊ", "ˇ", "ˋ", "˙"]);
const INITIALS = "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ";
const MEDIALS = "ㄧㄨㄩ";
const FINALS = "ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ";
const SYMBOLS = new Set([...INITIALS, ...MEDIALS, ...FINALS, ...TONES]);

async function main() {
  const commit = await resolveCommit();
  const dir = await mkdtemp(join(tmpdir(), "zhuyin-phrases-"));
  const [mappings, occ] = await Promise.all(
    FILES.map((path) => download(commit, path, dir))
  );

  const frequency = parseOccurrences(occ);
  const rows = parseMappings(mappings);
  // A phrase listed with several readings shares one count: the corpus counted
  // the characters, which is all it can see.
  for (const row of rows) {
    const counted = frequency.get(row.phrase) ?? 0;
    row.count = CONVERSATIONAL.has(row.phrase)
      ? Math.max(counted, CONVERSATIONAL_OCCURRENCES)
      : counted;
    row.score = score(row, frequency);
  }

  const kept = rows.filter(
    (row) => row.count >= MIN_OCCURRENCES || (row.count === 0 && row.length === 2)
  );
  // Score first, file order as the tiebreak — the same rule the dictionary
  // generator uses, and for the same reason: a stable tiebreak is what makes
  // the output reproducible. The zero-count rows fall to the end on their own.
  kept.sort((a, b) => b.score - a.score || a.rank - b.rank);

  const header = [
    "# 注音 phrase candidates — the table that lets the pane predict from the",
    "#   first symbol of each syllable: ㄋㄏ already offers 你好.",
    "# One row per (phrase, reading) pair: <phrase>\\t<syllables, space separated>.",
    "# Ordered by corpus frequency, most frequent first — the reader keeps file",
    "#   order and has no counts of its own.",
    "# GENERATED — run scripts/gen-zhuyin-phrases.mjs to rebuild; do not hand-edit.",
    `# Source: https://github.com/${REPO} @ ${commit}`,
    "#   Source/Data/BPMFMappings.txt + Source/Data/phrase.occ. MIT (McBopomofo),",
    "#   and BSD (libtabe) for the readings BPMFMappings.txt was simplified from.",
    "# See ios/THIRD-PARTY.md.",
  ];
  const lines = kept.map((row) => `${row.phrase}\t${row.reading}`);
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

/// How a row is ranked: the phrase's own count, damped, plus how ordinary its
/// characters are. Both halves are logs, which is what keeps a phrase the
/// corpus printed 50,000 times from burying one it printed 500 times — the gap
/// between those two is far smaller in a message than in a newspaper — and the
/// character term is what lifts a plain phrase like 我是 above a rarer compound
/// with the same reading.
function score(row, frequency) {
  let characters = 0;
  for (const character of row.phrase) {
    characters += Math.log((frequency.get(character) ?? 0) + 1);
  }
  return Math.log(row.count + 1) + characters / row.length;
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

/// `phrase.occ` is `<phrase> <count>`, single characters included. Both are
/// wanted: the phrase rows rank a phrase against its rivals, and the character
/// rows are the second half of `score`. One-character *rows* are never written
/// to the resource — that is the dictionary's job — but their counts are read.
function parseOccurrences(text) {
  const frequency = new Map();
  for (const line of text.split("\n")) {
    const [phrase, count] = line.split(/\s+/);
    if (!phrase) continue;
    frequency.set(phrase, Number(count) || 0);
  }
  return frequency;
}

/// `BPMFMappings.txt` is `<phrase> <syllable> <syllable> …`, one reading per
/// character, repeated for a phrase with more than one reading.
///
/// Everything in range is validated rather than trusted: a row the keyboard
/// could never type — a syllable it cannot spell, a character that is more than
/// one Unicode scalar, a reading that doesn't have one syllable per character —
/// would sit in the resource unreachable, so it is an error here instead. Rows
/// outside 2..MAX_LENGTH are *skipped*, which is a size decision and not a
/// complaint about the data.
function parseMappings(text) {
  const rows = [];
  const seen = new Set();
  let rank = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [phrase, ...syllables] = line.trim().split(/\s+/);
    const characters = [...phrase];
    if (characters.length < 2 || characters.length > MAX_LENGTH) continue;
    if (characters.length !== syllables.length) {
      throw new Error(`one reading per character, please: ${line}`);
    }
    for (const syllable of syllables) {
      for (const symbol of syllable) {
        if (!SYMBOLS.has(symbol)) throw new Error(`stray symbol in: ${line}`);
      }
      if (!wellFormed(syllable)) throw new Error(`not a syllable: ${line}`);
    }
    const reading = syllables.join(" ");
    // A phrase listed twice with the same reading would be shown twice in the
    // bar; upstream has none today, and this is what keeps it that way.
    const key = `${phrase}\t${reading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ phrase, reading, length: characters.length, rank: rank++ });
  }
  return rows;
}

/// The same shape `ZhuyinSyllable` enforces on the Swift side: at most one
/// symbol per slot, in slot order, tone last.
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

await main();
