// Which speaker in a recording is the user — the person the 評分 report scores.
//
// Three ways to know, tried in order:
//  1. "marked": the user ticked 這是我 on one speaker in the transcript.
//  2. "mic-track": the meeting was transcribed as two streams, so every "me"
//     line came from this computer's own mic.
//  3. "mic-activity": a diarized ("mix") meeting, where the transcript only
//     says Speaker 1, 2, 3. The mic was still captured on its own before the
//     mix (the prosody tap), and the live meeting kept a timeline of when it
//     heard speech. The speaker whose lines line up with that timeline — and
//     clearly better than anyone else's — is the user. In a room where the mic
//     hears everyone, no speaker stands out and this gives no answer.
// None of them → the user is unknown and the report asks to be told.

import type { TranscriptSegment } from "../types";
import { speakerKey } from "./labels";

/** A stretch of the live meeting, in recorded-ms, when the user's own mic
 *  heard speech (speaker bleed from the other side already rejected). */
export type MicSpan = readonly [startMs: number, endMs: number];

export type SelfOrigin = "marked" | "mic-track" | "mic-activity";

export interface SelfSpeaker {
  /** How the user was found — the report says so, and only a mic-based answer
   *  may use the mic's measured pace. */
  origin: SelfOrigin;
  /** The speaker key when one speaker is the user; null for "mic-track", where
   *  every "me" line is (a mic can carry more than one diarized number). */
  key: string | null;
  isSelf: (s: Pick<TranscriptSegment, "source" | "speaker">) => boolean;
}

/** How long one prosody sample stands for (the backend emits every ~150 ms). */
export const MIC_SAMPLE_MS = 150;
/** Two samples this close are one stretch of speech (a stop consonant or a
 *  breath flickers the voiced flag off for a frame or two). */
const MIC_BRIDGE_MS = 300;

/**
 * Fold one prosody sample into the mic timeline: `speaking` at `atMs` covers
 * the sample period before it. Returns the same array when nothing changed.
 * Pure; the store calls it on every prosody event of a live meeting.
 */
export function addMicSample(spans: readonly MicSpan[], atMs: number, speaking: boolean): readonly MicSpan[] {
  if (!speaking) return spans;
  const start = Math.max(0, atMs - MIC_SAMPLE_MS);
  const last = spans[spans.length - 1];
  if (last && start - last[1] <= MIC_BRIDGE_MS) {
    if (atMs <= last[1]) return spans;
    return [...spans.slice(0, -1), [last[0], atMs]];
  }
  return [...spans, [start, atMs]];
}

/** Below this much talk a speaker's mic overlap is noise, not evidence. */
const MIN_TALK_MS = 5000;
/** The user's lines must have the mic hearing speech at least this much… */
const MIN_COVERAGE = 0.3;
/** …and at least this many times more than the next speaker's. */
const MIN_LEAD = 2;

/** Ms of [start, end) the spans cover. `spans` is sorted and non-overlapping;
 *  `from` is where to start looking, returned advanced for the next call. */
function covered(spans: readonly MicSpan[], start: number, end: number, from: number): { ms: number; next: number } {
  let i = from;
  while (i < spans.length && spans[i][1] <= start) i++;
  const next = i;
  let ms = 0;
  for (; i < spans.length && spans[i][0] < end; i++) {
    ms += Math.max(0, Math.min(end, spans[i][1]) - Math.max(start, spans[i][0]));
  }
  return { ms, next };
}

/**
 * The diarized speaker the mic timeline points at, or null when it doesn't
 * single one out (no timeline, too little talk, or — in a room where the mic
 * hears everyone — nobody stands out). Pure; exported for testing.
 */
export function detectSelfFromMic(segments: readonly TranscriptSegment[], spans: readonly MicSpan[] | undefined): string | null {
  if (!spans || spans.length === 0) return null;
  const lines = segments
    .filter((s) => s.source === "mix" && s.isFinal && s.text.trim() && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const talk = new Map<string, { ms: number; heard: number }>();
  let from = 0;
  for (const s of lines) {
    const c = covered(spans, s.startMs, s.endMs, from);
    from = c.next;
    const key = speakerKey(s);
    const t = talk.get(key) ?? { ms: 0, heard: 0 };
    t.ms += s.endMs - s.startMs;
    t.heard += c.ms;
    talk.set(key, t);
  }
  const ranked = [...talk.entries()]
    .filter(([, t]) => t.ms >= MIN_TALK_MS)
    .map(([key, t]) => ({ key, coverage: t.heard / t.ms }))
    .sort((a, b) => b.coverage - a.coverage);
  const [best, second] = ranked;
  if (!best || best.coverage < MIN_COVERAGE) return null;
  if (second && best.coverage < second.coverage * MIN_LEAD) return null;
  return best.key;
}

function hasLine(segments: readonly TranscriptSegment[], match: (s: TranscriptSegment) => boolean): boolean {
  return segments.some((s) => s.isFinal && s.text.trim() && match(s));
}

const byKey = (key: string) => (s: Pick<TranscriptSegment, "source" | "speaker">) => speakerKey(s) === key;

// The pipeline asks on every store change; the answer only moves with the
// transcript, the mark or the timeline, so remember the last one.
let memo: {
  segments: readonly TranscriptSegment[];
  marked: string | null;
  spans: readonly MicSpan[] | undefined;
  result: SelfSpeaker | null;
} | null = null;

/** Who the user is in this recording, or null when nothing says. */
export function resolveSelf(
  segments: readonly TranscriptSegment[],
  marked: string | null,
  spans: readonly MicSpan[] | undefined,
): SelfSpeaker | null {
  if (memo && memo.segments === segments && memo.marked === marked && memo.spans === spans) return memo.result;
  const result = resolve(segments, marked, spans);
  memo = { segments, marked, spans, result };
  return result;
}

function resolve(
  segments: readonly TranscriptSegment[],
  marked: string | null,
  spans: readonly MicSpan[] | undefined,
): SelfSpeaker | null {
  // A mark on a speaker the transcript no longer has (re-diarized since) says nothing.
  if (marked && hasLine(segments, byKey(marked))) return { origin: "marked", key: marked, isSelf: byKey(marked) };
  if (hasLine(segments, (s) => s.source === "me")) {
    return { origin: "mic-track", key: null, isSelf: (s) => s.source === "me" };
  }
  const detected = detectSelfFromMic(segments, spans);
  if (detected) return { origin: "mic-activity", key: detected, isSelf: byKey(detected) };
  return null;
}
