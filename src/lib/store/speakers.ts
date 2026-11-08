// Speaker display names for the transcript on screen.

import type { TranscriptSegment } from "../types";
import { log } from "../log";
import { nextSpeakerAliases } from "../speakers/relabel";
import type { SliceCreator } from "./types";

export interface SpeakersSlice {
  /** Live speaker-key → custom name map (e.g. "them-1" → "重高"). Per meeting. */
  speakerNames: Record<string, string>;
  /** Speaker-key → names that speaker had before (oldest first). AI-written
   *  text cites a speaker by its name at generation time, so these let
   *  speakers/relabel.ts show it under the current one. Per meeting. */
  speakerAliases: Record<string, string[]>;
  /** Assign/clear a custom name for a speaker key (the previous name becomes
   *  an alias). On a saved recording the names are written back to it. */
  setSpeakerName: (key: string, name: string) => void;
  /** The speaker the user marked as themselves (這是我), or null. Per meeting.
   *  What the 評分 report scores — see speakers/self.ts for the fallbacks. */
  selfSpeaker: string | null;
  setSelfSpeaker: (key: string | null) => void;
  /** The speaker the user's voiceprint picked out in the loaded recording
   *  (speakers/voiceprint.ts), or null. Not saved: matched on each open. */
  voiceSelfKey: string | null;
  setVoiceSelfKey: (key: string | null) => void;
  /** Voice diarization landed: the re-numbered transcript and the names that
   *  belong to the new numbering, together. */
  applyDiarizedSpeakers: (segments: TranscriptSegment[], speakerNames: Record<string, string>) => void;
}

export const createSpeakersSlice: SliceCreator<SpeakersSlice> = (set) => ({
  speakerNames: {},
  speakerAliases: {},
  selfSpeaker: null,
  voiceSelfKey: null,

  setSelfSpeaker: (key) => set({ selfSpeaker: key }),
  setVoiceSelfKey: (key) => set({ voiceSelfKey: key }),

  setSpeakerName: (key, name) =>
    set((state) => {
      const next = { ...state.speakerNames };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      const keyAliases = nextSpeakerAliases(state.speakerAliases[key], state.speakerNames[key], name);
      const aliases = { ...state.speakerAliases };
      if (keyAliases.length) aliases[key] = keyAliases;
      else delete aliases[key];
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
      // Save the rename onto the loaded entry (debounced) so reopening it keeps
      // the names. Not for a read-only org recording, nor an unsaved session.
      const id = state.loadedHistoryId;
      if (id && !state.replayReadOnly) {
        import("../history/history")
          .then(({ scheduleSpeakerNamesPersist }) => scheduleSpeakerNamesPersist(id, next, aliases))
          .catch((error) => log.warn("speakers: name persist failed", { error: String(error) }));
      }
      return { speakerNames: next, speakerAliases: aliases };
    }),

  // New numbering: a 這是我 mark on the old one may now name someone else.
  applyDiarizedSpeakers: (segments, speakerNames) => set({ segments, speakerNames, speakerAliases: {}, selfSpeaker: null, voiceSelfKey: null }),
});
