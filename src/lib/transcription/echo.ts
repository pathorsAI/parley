// Speaker echo between the two live tracks.
//
// With separate tracks the mic is "me" and the system audio "them". Without
// headphones the other side's voice comes out of the speakers and into the
// mic, so the same sentence is transcribed twice: once (correctly) on "them",
// once on "me" — where it would be scored as the user's own speech. A "me"
// segment that overlaps a "them" segment in time and says nearly the same
// thing is that echo, and is dropped. This is a transcript-level guard, not
// acoustic echo cancellation: an echo the mic garbled past recognition stays.

import type { TranscriptSegment } from "../types";

/** How far apart the two copies may sit: loopback and mic latency differ, and
 *  each provider cuts segments on its own clock. */
const OVERLAP_SLACK_MS = 1500;
/** Below this many characters a match proves nothing: "對" / "OK" said by the
 *  user over the other side's "對" is a real backchannel, not an echo. */
const MIN_CHARS = 4;
/** Character-bigram Dice similarity at or above which two texts are one sentence. */
const SIMILARITY = 0.7;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = Array.from(s);
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams, 0..1. Order-tolerant enough for two
 *  recognizers wording the same audio slightly differently. */
export function textSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  if (total === 0) return 0;
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / total;
}

/** Whether `me` is the mic picking up `them` from the speakers. Final segments
 *  only: interim text is still changing. */
export function isEchoOf(me: TranscriptSegment, them: TranscriptSegment): boolean {
  if (me.source !== "me" || them.source !== "them") return false;
  if (!me.isFinal || !them.isFinal) return false;
  if (me.startMs > them.endMs + OVERLAP_SLACK_MS) return false;
  if (them.startMs > me.endMs + OVERLAP_SLACK_MS) return false;
  // Judge on the shorter text: the mic often catches only part of a sentence.
  const shorter = normalize(me.text).length <= normalize(them.text).length ? me.text : them.text;
  if (Array.from(normalize(shorter)).length < MIN_CHARS) return false;
  if (textSimilarity(me.text, them.text) >= SIMILARITY) return true;
  // A partial catch: the mic's copy is a fragment of the other side's sentence.
  const nm = normalize(me.text);
  return nm.length >= MIN_CHARS && normalize(them.text).includes(nm);
}

/** The ids of "me" segments in `segments` that echo `incoming` (a final "them"),
 *  or — when `incoming` is a final "me" — whether it echoes any "them" there. */
export function echoIdsFor(segments: TranscriptSegment[], incoming: TranscriptSegment): string[] {
  if (!incoming.isFinal) return [];
  if (incoming.source === "me") {
    return segments.some((s) => isEchoOf(incoming, s)) ? [incoming.id] : [];
  }
  if (incoming.source === "them") {
    return segments.filter((s) => isEchoOf(s, incoming)).map((s) => s.id);
  }
  return [];
}
