// Post-save voice re-diarization for LIVE meetings.
//
// Live speaker labels come from the STT provider's streaming diarization, which
// drifts over a long meeting: labels swap sides, and the same voice can be given
// a brand-new speaker number late in the call. Once the meeting is saved we hold
// the full recording on disk, so we re-derive the speakers from the AUDIO with
// the same on-device pipeline the upload flow uses (`diarize_audio`: CAM++
// embeddings + clustering), then map the new clusters back onto the provider's
// numbering by overlap — names and colors assigned during the meeting stay put,
// and only wrongly-labelled lines move. history.ts calls this right after the
// entry is persisted (see saveLiveToHistory).

import { log } from "../log";
import type { TranscriptSegment } from "../types";
import * as ipc from "../ipc/commands";

/** A segment's PRIOR (provider-assigned) speaker and its speech duration. */
export interface PriorSeg {
  id: string;
  speaker: number;
  weightMs: number;
}

/**
 * Map fresh cluster numbers onto the prior speaker numbering so existing names
 * and colors survive the re-clustering. Each cluster claims the prior speaker it
 * overlaps most (duration-weighted, one-to-one, strongest claims first); clusters
 * with no prior match get fresh numbers ABOVE every prior number, so they can't
 * collide with a label the meeting already used. Prior speaker 0 means "unknown"
 * and is never a target — those lines simply adopt their cluster's mapping.
 */
export function remapToPriorSpeakers(
  prior: PriorSeg[],
  assigned: { id: string; speaker: number }[],
): Map<number, number> {
  const priorById = new Map(prior.map((p) => [p.id, p]));
  // Total speech overlap (ms) between each new cluster and each prior speaker.
  const overlap = new Map<number, Map<number, number>>();
  const clusters = new Set<number>();
  for (const a of assigned) {
    clusters.add(a.speaker);
    const p = priorById.get(a.id);
    if (!p || p.speaker <= 0) continue;
    const row = overlap.get(a.speaker) ?? new Map<number, number>();
    row.set(p.speaker, (row.get(p.speaker) ?? 0) + Math.max(1, p.weightMs));
    overlap.set(a.speaker, row);
  }

  // Greedy one-to-one matching, strongest overlap first (ties break toward the
  // smaller prior/cluster number so the result is deterministic).
  const pairs: { cluster: number; prior: number; w: number }[] = [];
  for (const [cluster, row] of overlap) {
    for (const [p, w] of row) pairs.push({ cluster, prior: p, w });
  }
  pairs.sort((a, b) => b.w - a.w || a.prior - b.prior || a.cluster - b.cluster);
  const map = new Map<number, number>();
  const taken = new Set<number>();
  for (const { cluster, prior: p } of pairs) {
    if (map.has(cluster) || taken.has(p)) continue;
    map.set(cluster, p);
    taken.add(p);
  }

  let next = Math.max(0, ...prior.map((p) => p.speaker)) + 1;
  for (const cluster of [...clusters].sort((a, b) => a - b)) {
    if (!map.has(cluster)) map.set(cluster, next++);
  }
  return map;
}

/**
 * The groups of lines the re-diarization clusters, one per capture side:
 *
 * - "mix": a diarized-live meeting recorded as one mixed session. Every voice
 *   is in the file, so the whole transcript is one group.
 * - "me" / "them": a separate-tracks meeting. The recording is the mix of both
 *   sides, but the transcript already knows which side each line came from, so
 *   each side is re-clustered on its own: mic voices become me 1, me 2…, far
 *   voices remote 1, remote 2…, and a voice can never move across sides.
 *
 * A "me"/"them" side only qualifies when the provider diarized it (some line
 * has a speaker number). Older meetings from providers without diarization ran
 * two undiarized sessions and recorded the mic alone, so their "them" lines are
 * not in the file and must not be clustered against it.
 */
function lineGroups(segments: TranscriptSegment[]): TranscriptSegment[][] {
  const spoken = segments.filter((s) => s.isFinal && s.text.trim());
  const groups: TranscriptSegment[][] = [];
  for (const source of ["mix", "me", "them"] as const) {
    const lines = spoken.filter((s) => s.source === source);
    if (lines.length < 2) continue;
    if (source !== "mix" && !lines.some((s) => s.speaker > 0)) continue;
    groups.push(lines.sort((a, b) => a.startMs - b.startMs));
  }
  return groups;
}

/**
 * Whether {@link rediarizeSegments} can do anything for these segments: some
 * side (see {@link lineGroups}) with at least two spoken lines. Lets the caller
 * skip raising the "correcting speakers" gate for a pass that would return
 * null without touching the audio.
 */
export function qualifiesForRediarization(segments: TranscriptSegment[]): boolean {
  return lineGroups(segments).length > 0;
}

/** Re-cluster one side's lines; returns line id → corrected speaker number. */
async function rediarizeGroup(lines: TranscriptSegment[], audioPath: string): Promise<Map<string, number>> {
  const spans = lines.map((s) => ({
    id: s.id,
    startMs: Math.max(0, Math.round(s.startMs)),
    endMs: Math.max(0, Math.round(s.endMs)),
  }));
  const assigned = await ipc.diarizeAudio({ audioPath, segments: spans, numSpeakers: null });
  const priors: PriorSeg[] = lines.map((s) => ({
    id: s.id,
    speaker: s.speaker,
    weightMs: Math.max(1, s.endMs - s.startMs),
  }));
  const clusterMap = remapToPriorSpeakers(priors, assigned);
  const idToSpeaker = new Map<string, number>();
  for (const a of assigned) {
    const sp = clusterMap.get(a.speaker);
    if (sp !== undefined) idToSpeaker.set(a.id, sp);
  }
  log.info("postDiarize: clustered", {
    source: lines[0]?.source,
    segs: lines.length,
    speakers: new Set(idToSpeaker.values()).size,
  });
  return idToSpeaker;
}

/**
 * Re-derive speakers for a finished live meeting's segments from its recording,
 * one side at a time (see {@link lineGroups}). Speaker numbers stay within their
 * side, so "me 2" and "remote 2" are different people.
 *
 * The speaker count is auto-detected from the audio rather than seeded with the
 * provider's count, because late-meeting over-splitting (a spurious extra
 * speaker) is exactly the drift this pass exists to fix.
 *
 * Returns the full segment list with corrected speaker numbers, or null when
 * the pass doesn't apply or nothing changed. Pure with respect to the store —
 * persistence and UI refresh are the caller's job (history.ts).
 */
export async function rediarizeSegments(
  segments: TranscriptSegment[],
  audioPath: string,
): Promise<{ segments: TranscriptSegment[]; changed: number } | null> {
  const groups = lineGroups(segments);
  if (groups.length === 0) return null;

  const idToSpeaker = new Map<string, number>();
  for (const lines of groups) {
    for (const [id, sp] of await rediarizeGroup(lines, audioPath)) idToSpeaker.set(id, sp);
  }

  let changed = 0;
  const patched = segments.map((s) => {
    const sp = idToSpeaker.get(s.id);
    if (sp === undefined || sp === s.speaker) return s;
    changed++;
    return { ...s, speaker: sp };
  });
  return changed > 0 ? { segments: patched, changed } : null;
}
