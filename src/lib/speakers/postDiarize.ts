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

import { invoke } from "@tauri-apps/api/core";
import { log } from "../log";
import type { TranscriptSegment } from "../types";

/** One segment's speaker assignment from the Rust `diarize_audio` command. */
interface RustSegSpeaker {
  id: string;
  /** 1-based speaker number (cluster + 1). */
  speaker: number;
  /** Cosine margin to the next-nearest cluster; 0 for inherited short segments. */
  confidence: number;
}

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
 * Re-derive speakers for a finished live meeting's segments from its recording.
 *
 * Only the diarized-live case qualifies: those meetings record the mic+system
 * MIX, so the file actually contains every voice. Mic-only meetings ("me"/"them"
 * segments) keep their channel-derived labels — the counterpart's audio isn't in
 * the recording, so re-clustering it would be meaningless.
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
  const mix = segments
    .filter((s) => s.source === "mix" && s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  // One line can't drift; nothing to re-cluster.
  if (mix.length < 2) return null;

  const spans = mix.map((s) => ({
    id: s.id,
    startMs: Math.max(0, Math.round(s.startMs)),
    endMs: Math.max(0, Math.round(s.endMs)),
  }));
  const assigned = await invoke<RustSegSpeaker[]>("diarize_audio", {
    audioPath,
    segments: spans,
    numSpeakers: null,
  });

  const priors: PriorSeg[] = mix.map((s) => ({
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

  let changed = 0;
  const patched = segments.map((s) => {
    const sp = idToSpeaker.get(s.id);
    if (sp === undefined || sp === s.speaker) return s;
    changed++;
    return { ...s, speaker: sp };
  });
  log.info("postDiarize: clustered", {
    segs: mix.length,
    changed,
    speakers: new Set(idToSpeaker.values()).size,
  });
  return changed > 0 ? { segments: patched, changed } : null;
}
