// The transcript on screen (live or loaded), and the live filler-sound tally
// folded in as the user's own segments arrive.

import type { TranscriptSegment } from "../types";
import { countFillerSounds } from "../analysis/fillerWords";
import type { ParleyState, SliceCreator } from "./types";

export interface SegmentsSlice {
  segments: TranscriptSegment[];
  /** Running count of filler SOUNDS ("um/uh/嗯/呃") heard this meeting. Counted
   *  from the USER'S live transcript ("me" segments) against a global filler map
   *  (see countFillerSounds) so it updates in real time and works across
   *  languages. Reset on meeting start. */
  filledPauseCount: number;
  /** Per-segment filler-sound tally already folded into `filledPauseCount`.
   *  Interim segments grow/rewrite as they finalize, so we re-count each segment
   *  and add only the delta — keyed by segment id. Reset on meeting start. */
  filledPauseCounted: Record<string, number>;

  // transcript
  /**
   * Upsert a segment by id. Realtime sources emit the same id repeatedly with
   * growing text (partial → final); we replace in place rather than appending.
   */
  upsertSegment: (segment: TranscriptSegment) => void;
  /** Replace the transcript wholesale (a correction folded over it). */
  setSegments: (segments: TranscriptSegment[]) => void;
  clearTranscript: () => void;
}

/**
 * Tally filler sounds ("um/嗯…") from the USER'S OWN speech, live. Interim
 * segments grow and rewrite as they finalize, so re-count this segment and fold
 * in only the delta versus what we already counted for its id.
 */
function fillerPatchFor(
  state: Pick<ParleyState, "filledPauseCount" | "filledPauseCounted">,
  segment: TranscriptSegment,
): Partial<ParleyState> {
  if (segment.source !== "me") return {};
  const prev = state.filledPauseCounted[segment.id] ?? 0;
  const now = countFillerSounds(segment.text);
  if (now === prev) return {};
  return {
    filledPauseCount: Math.max(0, state.filledPauseCount + (now - prev)),
    filledPauseCounted: { ...state.filledPauseCounted, [segment.id]: now },
  };
}

export const createSegmentsSlice: SliceCreator<SegmentsSlice> = (set) => ({
  segments: [],
  filledPauseCount: 0,
  filledPauseCounted: {},

  upsertSegment: (segment) =>
    set((state) => {
      // Live transcript events must never mutate a loaded REPLAY recording — drop a
      // stray live event (e.g. a leaked listener) while viewing a saved session.
      // (Live finalize after stop is appMode "live"/"stopped", so it's unaffected.)
      if (state.appMode === "study") return {};

      const fillerPatch = fillerPatchFor(state, segment);

      const idx = state.segments.findIndex((s) => s.id === segment.id);
      if (idx === -1) {
        return { segments: [...state.segments, segment], ...fillerPatch };
      }
      const next = state.segments.slice();
      next[idx] = segment;
      return { segments: next, ...fillerPatch };
    }),

  setSegments: (segments) => set({ segments }),
  clearTranscript: () => set({ segments: [] }),
});
