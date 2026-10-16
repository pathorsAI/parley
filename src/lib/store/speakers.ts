// Speaker display names for the transcript on screen.

import type { TranscriptSegment } from "../types";
import { log } from "../log";
import type { SliceCreator } from "./types";

export interface SpeakersSlice {
  /** Live speaker-key → custom name map (e.g. "them-1" → "重高"). Per meeting. */
  speakerNames: Record<string, string>;
  /** Assign/clear a custom name for a speaker key. */
  setSpeakerName: (key: string, name: string) => void;
  /** Voice diarization landed: the re-numbered transcript and the names that
   *  belong to the new numbering, together. */
  applyDiarizedSpeakers: (segments: TranscriptSegment[], speakerNames: Record<string, string>) => void;
}

export const createSpeakersSlice: SliceCreator<SpeakersSlice> = (set) => ({
  speakerNames: {},

  setSpeakerName: (key, name) =>
    set((state) => {
      const next = { ...state.speakerNames };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      // Persist names per uploaded recording so re-uploading restores them. Replay
      // only — a live meeting has no stable on-disk recording to key against.
      const audioPath = state.replay?.audioPath;
      if (audioPath) {
        const segments = state.segments;
        import("../speakers/namesCache")
          .then(({ writeSpeakerNames, speakerCountOf }) =>
            writeSpeakerNames(audioPath, speakerCountOf(segments), next)
          )
          .catch((error) => log.warn("speakers: name cache write failed", { error: String(error) }));
      }
      return { speakerNames: next };
    }),

  applyDiarizedSpeakers: (segments, speakerNames) => set({ segments, speakerNames }),
});
