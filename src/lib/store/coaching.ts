// Live delivery coaching (LIVE only; "me" mic, issue #22) and the live
// auto-analysis interval.

import type { DeliveryNudge, ProsodyMetrics } from "../types";
import { addMicSample, type MicSpan } from "../speakers/self";
import { meetingElapsedMs } from "./meeting";
import type { SliceCreator } from "./types";

export interface CoachingSlice {
  /** Auto-run the analysis on an interval while recording (LIVE; default off). */
  autoAnalyze: boolean;
  autoAnalyzeSec: number;
  setAutoAnalyze: (on: boolean) => void;
  setAutoAnalyzeSec: (sec: number) => void;

  /** Latest prosody metrics from the backend; null until the first event. */
  prosody: ProsodyMetrics | null;
  setProsody: (m: ProsodyMetrics | null) => void;
  /** Whole-session articulation rate of the USER'S MIC (last `sessionRateHz`
   *  seen). Unlike `prosody`, this survives stop so the history save can record
   *  a mic-only measured pace — never the counterpart's (issue #22). Reset on
   *  meeting start. */
  micSessionRateHz: number | null;
  /** When the user's own mic heard speech, in recorded-ms (the transcript's
   *  clock). Saved with a diarized meeting so the 評分 report can tell which
   *  Speaker N is the user (speakers/self.ts). Reset on meeting start. */
  micActivity: readonly MicSpan[];
  /** The transient coaching nudge currently shown (null = none). */
  deliveryNudge: DeliveryNudge | null;
  /** Show a nudge (replaces any current one); the UI auto-dismisses it. */
  pushDeliveryNudge: (n: DeliveryNudge) => void;
  clearDeliveryNudge: () => void;
}

export const createCoachingSlice: SliceCreator<CoachingSlice> = (set) => ({
  autoAnalyze: false,
  autoAnalyzeSec: 45,
  prosody: null,
  micSessionRateHz: null,
  micActivity: [],
  deliveryNudge: null,

  setAutoAnalyze: (on) => set({ autoAnalyze: on }),
  setAutoAnalyzeSec: (sec) => set({ autoAnalyzeSec: Math.max(20, sec || 45) }),

  // Prosody is a live-only signal. Ignore non-null updates outside a recording so a
  // leaked/duplicate listener (e.g. a dev StrictMode re-subscribe, or a backend
  // frame slipping through stop_meeting's teardown grace) can't move the gauges
  // after stop. A null reset always applies. (Filler SOUNDS are no longer tallied
  // here — the acoustic DSP flag missed too many; they're counted from the live
  // transcript in `upsertSegment` instead.)
  setProsody: (m) =>
    set((state) => {
      if (!m) return { prosody: null };
      if (state.meetingStatus !== "recording") return {};
      return {
        prosody: m,
        // Kept outside `prosody` so it survives the stop-time reset: the history
        // save reads it as the mic-only measured pace (issue #22).
        micSessionRateHz: m.sessionRateHz > 0 ? m.sessionRateHz : state.micSessionRateHz,
        // Paused: nothing is recorded, so nothing is on the transcript's clock.
        micActivity:
          state.meetingPausedAt == null
            ? addMicSample(state.micActivity, meetingElapsedMs(state), m.speaking)
            : state.micActivity,
      };
    }),
  pushDeliveryNudge: (n) => set({ deliveryNudge: n }),
  clearDeliveryNudge: () => set({ deliveryNudge: null }),
});
