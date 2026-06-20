import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { log } from "../log";

/** One segment's speaker assignment from the Rust `diarize_audio` command. */
interface RustSegSpeaker {
  id: string;
  /** 1-based speaker number (cluster + 1). */
  speaker: number;
  /** Cosine margin to the next-nearest cluster; 0 for inherited short segments. */
  confidence: number;
}

/**
 * Re-derive speakers from the AUDIO of the loaded recording (not the STT's
 * diarization, not the LLM). Slices the audio by the existing segment timestamps,
 * embeds each slice with a local voice model, and clusters the embeddings into
 * speakers — solving reversed sides / over-splitting that text-based methods can't.
 *
 * `numSpeakers = null` auto-detects the count; a number forces exactly that many.
 * Applies straight to the store by rewriting each segment's `speaker` number, so
 * the transcript, the speaker roster, and every analysis update at once. Speaker
 * names are left as defaults (Speaker 1, 2, …) for the user to rename inline.
 *
 * Returns how many lines were assigned and how many speakers were found.
 */
export async function runVoiceDiarize(opts: {
  numSpeakers: number | null;
}): Promise<{ assigned: number; total: number; speakers: number }> {
  const { replay, segments } = useStore.getState();
  if (!replay?.audioPath) {
    log.warn("diarize: no recording loaded");
    throw new Error("No recording loaded to diarize.");
  }

  const finalSegs = segments
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  log.info("diarize: start", {
    segs: finalSegs.length,
    numSpeakers: opts.numSpeakers,
  });
  if (finalSegs.length === 0) {
    throw new Error("No transcript to diarize.");
  }

  const spans = finalSegs.map((s) => ({
    id: s.id,
    startMs: Math.max(0, Math.round(s.startMs)),
    endMs: Math.max(0, Math.round(s.endMs)),
  }));

  const result = await invoke<RustSegSpeaker[]>("diarize_audio", {
    audioPath: replay.audioPath,
    segments: spans,
    numSpeakers: opts.numSpeakers,
  });

  // Map segment id → new speaker number; rewrite over the FULL segment list.
  const idToSpeaker = new Map<string, number>();
  let speakers = 0;
  for (const r of result) {
    idToSpeaker.set(r.id, r.speaker);
    if (r.speaker > speakers) speakers = r.speaker;
  }

  const updated = useStore.getState().segments.map((s) => {
    const sp = idToSpeaker.get(s.id);
    return sp ? { ...s, speaker: sp } : s;
  });
  useStore.setState({ segments: updated });

  log.info("diarize: applied", { assigned: idToSpeaker.size, speakers });
  return { assigned: idToSpeaker.size, total: finalSegs.length, speakers };
}
