//! Speech facts for the post-meeting 評分 report, computed from the saved
//! transcript alone: segment text and timing, no audio and no model.
//!
//! "Me" is the user's own mic. In a diarized "mix" session there is no "me"
//! track, so the facts fall back to everyone's speech (see computeSpeechStats).
//!
//! Segment-level timing only: a pause inside one segment is invisible, so pause
//! counts are a floor, not an exact tally.

import type { TranscriptSegment } from "../types";
import { countFillersByWord, topFillers, type FillerCount } from "./fillerWords";

/** A silence between two of the user's own segments at least this long, with
 *  nobody else talking, counts as a pause. */
export const PAUSE_MIN_MS = 1000;
/** Longer than this and the user had simply stopped talking for a while. */
export const PAUSE_MAX_MS = 30_000;

const CJK = /[㐀-鿿豈-﫿]/gu;
const LATIN_WORD = /[a-z0-9']+/giu;

/** How much was said: CJK characters plus Latin words — the 字 of 字/分. */
export function speechUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").match(LATIN_WORD)?.length ?? 0;
  return cjk + latin;
}

export interface PacePoint {
  /** Bucket start, ms into the recording. */
  atMs: number;
  /** 字/分 over the user's own talk in this bucket. */
  perMin: number;
}

export interface Pause {
  atMs: number;
  ms: number;
}

export interface Repetition {
  atMs: number;
  text: string;
}

export interface SpeechStats {
  durationMs: number;
  /** The user's own talk time and how much they said. */
  myTalkMs: number;
  myUnits: number;
  /** 字/分 over the user's talk time; null with under 20 s of talk. */
  textPace: number | null;
  /** Pace across the meeting, one point per bucket with enough talk. */
  paceTimeline: PacePoint[];
  bucketMs: number;
  pauses: Pause[];
  fillers: FillerCount[];
  fillerTotal: number;
  repetitions: Repetition[];
}

/** Bucket width: 1 min for meetings under 20 min, else 2 min, else wider so
 *  the charts never get more than 40 columns. */
function bucketWidth(durationMs: number): number {
  const min = 60_000;
  if (durationMs <= 20 * min) return min;
  return Math.max(2 * min, Math.ceil(durationMs / 40 / min) * min);
}

/** Immediately repeated words: 我覺得我覺得, "the the". Single CJK characters
 *  are left out — 謝謝, 看看 and 常常 are words, not stumbles. */
const CJK_REPEAT = /([㐀-鿿]{2,4})[\s,，、]*\1/gu;
const LATIN_REPEAT = /\b([a-z']+)\s+\1\b/giu;

function findRepetitions(seg: TranscriptSegment, into: Repetition[]): void {
  for (const re of [CJK_REPEAT, LATIN_REPEAT]) {
    re.lastIndex = 0;
    for (let m = re.exec(seg.text); m !== null; m = re.exec(seg.text)) {
      into.push({ atMs: seg.startMs, text: m[0] });
    }
  }
}

function spokenSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => s.isFinal && s.text.trim() && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Every fact the 評分 report shows that the transcript alone can answer. */
export function computeSpeechStats(segments: TranscriptSegment[]): SpeechStats {
  const spoken = spokenSegments(segments);
  const durationMs = spoken.reduce((m, s) => Math.max(m, s.endMs), 0);
  const bucketMs = bucketWidth(durationMs);
  const buckets = Math.max(1, Math.ceil(durationMs / bucketMs));
  const mine = spoken.filter((s) => s.source === "me");
  // A recording without a "me" track (an upload, a diarized mix) is all the
  // user's to read: the pace and habit facts then cover everyone in it.
  const own = mine.length > 0 ? mine : spoken;

  const paceUnits = new Array<number>(buckets).fill(0);
  const paceMs = new Array<number>(buckets).fill(0);
  let myTalkMs = 0;
  let myUnits = 0;
  const fillerCounts = new Map<string, number>();
  const repetitions: Repetition[] = [];

  for (const s of own) {
    const i = Math.min(buckets - 1, Math.floor(s.startMs / bucketMs));
    const ms = s.endMs - s.startMs;
    const units = speechUnits(s.text);
    myTalkMs += ms;
    myUnits += units;
    paceUnits[i] += units;
    paceMs[i] += ms;
    countFillersByWord(s.text, fillerCounts);
    findRepetitions(s, repetitions);
  }

  const paceTimeline: PacePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    // Under 10 s of talk in a bucket is too little to call a pace.
    if (paceMs[i] >= 10_000) paceTimeline.push({ atMs: i * bucketMs, perMin: Math.round(paceUnits[i] / (paceMs[i] / 60_000)) });
  }

  // Pauses: the gap between two consecutive own segments that nobody else
  // spoke in.
  const pauses: Pause[] = [];
  for (let k = 1; k < own.length; k++) {
    const a = own[k - 1];
    const b = own[k];
    const gap = b.startMs - a.endMs;
    if (gap < PAUSE_MIN_MS || gap > PAUSE_MAX_MS) continue;
    const filled = spoken.some((o) => o.source !== a.source && o.startMs < b.startMs && o.endMs > a.endMs);
    if (!filled) pauses.push({ atMs: a.endMs, ms: gap });
  }

  const fillers = topFillers(fillerCounts, 8);
  let fillerTotal = 0;
  for (const n of fillerCounts.values()) fillerTotal += n;

  return {
    durationMs,
    myTalkMs,
    myUnits,
    textPace: myTalkMs >= 20_000 ? Math.round(myUnits / (myTalkMs / 60_000)) : null,
    paceTimeline,
    bucketMs,
    pauses,
    fillers,
    fillerTotal,
    repetitions,
  };
}

/** mm:ss (or h:mm:ss) for a position in the recording. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
