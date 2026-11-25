// Speaker echo between the two live tracks.
//
// With separate tracks the mic is "me" and the system audio "them". Without
// headphones the other side's voice comes out of the speakers and into the
// mic, so the same speech is transcribed twice: once (correctly) on "them",
// once on "me" — where it would be scored as the user's own speech. This is a
// transcript-level guard, not acoustic echo cancellation: a "me" line whose
// words the other side said, in order, at the same moment, is that echo and is
// dropped. An echo the mic garbled past recognition stays.
//
// The two copies come from two recognizers hearing different audio (clean
// loopback vs. a room-coloured mic), so they rarely match character for
// character: "Here's my PC. It does not have a mic." on the mic against "Just
// my PC does not have mic." on the loopback. Each side also cuts its lines on
// its own clock — one long remote monologue can come back from the mic as
// several short lines. So the test is directional: how much of the MIC line is
// explained by what the other side said around the same time. A user's own
// sentence that merely repeats a few of the other side's words keeps most of
// its words unexplained and survives.
//
// It errs towards keeping: a missed echo is a duplicated line, a false one
// deletes something the user really said.

import type { TranscriptSegment } from "../types";

/** The two copies must overlap in time: the mic hears the speakers with no
 *  perceptible delay. This slack (edge to edge) only absorbs the two providers
 *  stamping their lines on slightly different clocks. Requiring overlap is what
 *  keeps the user repeating the other side right after them ("一百個坐席?" →
 *  "對，一百個坐席"): on the real call every long echo overlapped its source. */
const OVERLAP_SLACK_MS = 250;
/** Below this many tokens a line is a short reply ("對", "Hmm", "Yeah"), which
 *  the user says over the other side all the time. */
const MIN_TOKENS = 4;
/** Share of a mic line's tokens that must appear, in order, in the other
 *  side's speech for it to be an echo. Tuned on a real hour-long English call
 *  against time-shifted controls (shifting the other side by 30 s to 4 min
 *  matches almost nothing at this level). */
const COVERAGE = 0.65;
/** A short reply is an echo only when the other side said exactly the same at
 *  the same moment — the mic hears the speakers with no perceptible delay. */
const SHORT_START_SLACK_MS = 600;

/** Words for alphabetic scripts, single characters for scripts written without
 *  spaces (a CJK or Thai character carries about a word's information). */
export function echoTokens(text: string): string[] {
  const raw =
    text
      .toLowerCase()
      .match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]|[\p{L}\p{N}']+/gu,
      ) ?? [];
  return raw.map((t) => t.replace(/'/g, "")).filter(Boolean);
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

/**
 * Share (0..1) of `line`'s tokens found, in order, within one stretch of
 * `other` no longer than about 1.5× the line. Bounding the stretch is what
 * keeps a short mic line from being "explained" by common words scattered
 * across a long monologue.
 */
export function echoCoverage(line: readonly string[], other: readonly string[]): number {
  const n = line.length;
  if (n === 0 || other.length === 0) return 0;
  const width = Math.ceil(n * 1.5) + 2;
  if (other.length <= width) return lcsLength(line, other) / n;
  const first = new Set(line);
  let best = 0;
  for (let start = 0; start + 1 <= other.length; start++) {
    // A best stretch can always be trimmed to start on a matched token.
    if (!first.has(other[start])) continue;
    best = Math.max(best, lcsLength(line, other.slice(start, start + width)));
    if (best === n) break;
  }
  return best / n;
}

function edgeGapMs(a: TranscriptSegment, b: TranscriptSegment): number {
  return Math.max(a.startMs - b.endMs, b.startMs - a.endMs);
}

function isFinalLine(s: TranscriptSegment, source: "me" | "them"): boolean {
  return s.source === source && s.isFinal && s.text.trim() !== "";
}

/**
 * Whether the final "me" line `me` is the mic picking up the other side, judged
 * against every final "them" line in `segments`.
 */
export function isEcho(me: TranscriptSegment, segments: readonly TranscriptSegment[]): boolean {
  if (!isFinalLine(me, "me")) return false;
  const near = segments
    .filter((t) => isFinalLine(t, "them") && edgeGapMs(me, t) <= OVERLAP_SLACK_MS)
    .sort((a, b) => a.startMs - b.startMs);
  if (near.length === 0) return false;
  const mine = echoTokens(me.text);
  if (mine.length === 0) return false;
  if (mine.length < MIN_TOKENS) {
    const key = mine.join(" ");
    return near.some(
      (t) => Math.abs(t.startMs - me.startMs) <= SHORT_START_SLACK_MS && echoTokens(t.text).join(" ") === key,
    );
  }
  // Their lines around this one, in order: the mic may have caught the end of
  // one and the start of the next as a single line.
  const theirs = near.flatMap((t) => echoTokens(t.text));
  return echoCoverage(mine, theirs) >= COVERAGE;
}

/** The ids of the "me" lines that `incoming` settles as echoes: itself, when it
 *  is a final "me" line echoing the other side; or, when it is a final "them"
 *  line, the user's lines around it that it now explains. */
export function echoIdsFor(segments: readonly TranscriptSegment[], incoming: TranscriptSegment): string[] {
  if (!incoming.isFinal) return [];
  if (incoming.source === "me") {
    const others = segments.filter((s) => s.id !== incoming.id);
    return isEcho(incoming, others) ? [incoming.id] : [];
  }
  if (incoming.source === "them") {
    const all = [...segments.filter((s) => s.id !== incoming.id), incoming];
    return segments
      .filter((s) => isFinalLine(s, "me") && edgeGapMs(s, incoming) <= OVERLAP_SLACK_MS && isEcho(s, all))
      .map((s) => s.id);
  }
  return [];
}

/** `segments` without the mic's echoes of the other side; the same array when
 *  there are none. For transcripts that did not come through the live filter:
 *  ones saved before it existed, or recorded while it missed. */
export function withoutEchoes<T extends TranscriptSegment>(segments: T[]): T[] {
  if (!segments.some((s) => s.source === "me") || !segments.some((s) => s.source === "them")) return segments;
  const kept = segments.filter((s) => !isEcho(s, segments));
  return kept.length === segments.length ? segments : kept;
}
