// The live meeting's lifecycle (recording → paused → stopped / cancelled),
// its clock, and the health of its transcription link.

import type { MeetingStatus } from "../types";
import { log } from "../log";
import { CLEARED_STUDY_SLICE } from "./study";
import type { ParleyState, SliceCreator, TranscriptionLink } from "./types";

export interface MeetingSlice {
  meetingStatus: MeetingStatus;
  /** True from "End meeting" until the recording's first file write lands and
   *  its report opens (or Rust reports it was discarded, or the save fails).
   *  Backs the titlebar "saving…" state so the multi-second encode → persist
   *  window doesn't look hung, and keeps the shell's focused layout up until the
   *  report replaces the cockpit. Speaker re-diarization and the org share run
   *  AFTER it clears — see postSaveDiarizingId. */
  isFinalizingMeeting: boolean;
  setFinalizingMeeting: (v: boolean) => void;
  meetingStartedAt: number | null;
  /** When the CURRENT pause began (epoch ms), null while not paused. */
  meetingPausedAt: number | null;
  /** Total paused time (ms) accumulated by PREVIOUS pauses this meeting —
   *  excludes the ongoing pause. With `meetingPausedAt`, lets the UI show
   *  recorded-time elapsed (see {@link meetingElapsedMs}) that matches the
   *  pause-compacted recording + transcript timeline. */
  meetingPausedTotalMs: number;

  /** System-audio tap failed for THIS meeting: mic-only capture, the other
   *  side won't be transcribed. Drives the persistent live banner (⑥) — a
   *  10-second toast is gone before the user notices the silence. Reset on
   *  meeting start; dismissable. */
  systemAudioWarning: boolean;
  setSystemAudioWarning: (on: boolean) => void;

  /** The live transcript's connection, for THIS meeting (#570). A dropped
   *  transcription socket no longer ends the meeting: the backend keeps the
   *  microphone recording and redials with backoff, so a network blip is a
   *  pause in the live transcript, never the end of a recording. "reconnecting"
   *  drives the live screen's non-dismissable banner and clears by itself once
   *  every leg that dropped has reported back in. */
  transcriptionLink: TranscriptionLink;
  /** The link went to "reconnecting" at least once this meeting. Sticky until
   *  the next startMeeting (or a cancel) — stopping keeps it, because the save that runs
   *  AFTER stop reads it: a meeting whose transcription was interrupted is
   *  saved even with no transcript, since the recording may be the only copy
   *  of what was said (history.shouldKeepLiveRecording). */
  transcriptionDropped: boolean;
  /** Which sources ("mix", or "me"/"them" when two sessions run) are currently
   *  redialling. The link is reconnecting while ANY is; it reads live again
   *  only once each of them has reported live. */
  transcriptionReconnectingSources: string[];
  /** Fold one `meeting://transcription` report into the three fields above.
   *  Ignored outside an active meeting (a stray event racing stop_meeting's
   *  teardown must not raise the banner over a finished call), and a "live"
   *  from a source that never reported reconnecting — every leg's FIRST
   *  handshake also reports live — is a no-op. */
  reportTranscriptionLink: (source: string, state: TranscriptionLink) => void;

  /** When the silence guard asked "is this meeting over?" (epoch ms), null
   *  while it isn't asking. Drives the live screen's countdown banner; the
   *  guard itself (meeting/silenceGuard.ts) decides when to raise and clear
   *  it. Cleared by every lifecycle change — start, pause, stop, cancel. */
  silencePromptAt: number | null;
  setSilencePrompt: (at: number | null) => void;
  /** The backend is still recording a meeting this window knows nothing about
   *  (it reloaded under a running capture). Mark the save that its stop will
   *  trigger as one to keep even without a transcript — the recording is the
   *  only copy of that meeting — the same way a dropped transcription does. */
  adoptOrphanedRecording: () => void;

  // meeting lifecycle
  startMeeting: () => void;
  stopMeeting: () => void;
  /** Freeze the live meeting (recording → paused). The backend drops audio
   *  while paused; segments finalizing from PRE-pause audio still land. */
  pauseMeeting: () => void;
  /** Continue a paused meeting (paused → recording), folding the finished
   *  pause into {@link meetingPausedTotalMs}. */
  resumeMeeting: () => void;
  /** Abandon the live meeting entirely: transcript + study outputs are
   *  discarded and the app returns to idle — nothing is saved or analyzed
   *  (the caller also invokes the backend `cancel_meeting`, which discards
   *  the recording instead of encoding it). */
  cancelMeeting: () => void;
}

/**
 * The transcription link back at rest: live, nothing redialling. Applied on
 * start, stop and cancel — a stopped meeting must not keep showing the
 * reconnecting banner (the backend stops redialling with the meeting), and the
 * next one starts clean. `transcriptionDropped` is NOT part of it: stop keeps
 * that flag for the save that follows, and only startMeeting/cancelMeeting
 * clear it.
 */
const CLEARED_TRANSCRIPTION_LINK: Pick<
  ParleyState,
  "transcriptionLink" | "transcriptionReconnectingSources"
> = {
  transcriptionLink: "live",
  transcriptionReconnectingSources: [],
};

/**
 * Is a live meeting in progress (recording or paused)? Paused meetings still
 * own the mic and the STT sessions, so every "don't do X while recording"
 * guard (navigation, ingest, close-window stop) must treat them as active.
 */
export function isMeetingActive(status: MeetingStatus): boolean {
  return status === "recording" || status === "paused";
}

/**
 * Elapsed RECORDED time of the live meeting (ms): wall time since start minus
 * every paused span (including the ongoing one). Matches the pause-compacted
 * recording + the STT timeline, so the titlebar clock and the live analysis
 * axis line up with segment timestamps instead of drifting ahead over pauses.
 */
export function meetingElapsedMs(
  s: Pick<ParleyState, "meetingStartedAt" | "meetingPausedAt" | "meetingPausedTotalMs">,
  now: number = Date.now()
): number {
  if (s.meetingStartedAt == null) return 0;
  const end = s.meetingPausedAt ?? now;
  return Math.max(0, end - s.meetingStartedAt - s.meetingPausedTotalMs);
}

/** Fold one link report into the link fields (see reportTranscriptionLink). */
function foldTranscriptionLink(
  state: ParleyState,
  source: string,
  linkState: TranscriptionLink,
): Partial<ParleyState> {
  if (!isMeetingActive(state.meetingStatus)) return {};
  const pending = state.transcriptionReconnectingSources;
  if (linkState === "reconnecting") {
    return {
      transcriptionLink: "reconnecting",
      transcriptionDropped: true,
      // Re-reported on every redial attempt while offline: keep one entry.
      transcriptionReconnectingSources: pending.includes(source) ? pending : [...pending, source],
    };
  }
  if (!pending.includes(source)) return {};
  const rest = pending.filter((s) => s !== source);
  return {
    transcriptionReconnectingSources: rest,
    transcriptionLink: rest.length === 0 ? "live" : "reconnecting",
  };
}

export const createMeetingSlice: SliceCreator<MeetingSlice> = (set) => ({
  meetingStatus: "idle",
  isFinalizingMeeting: false,
  meetingStartedAt: null,
  meetingPausedAt: null,
  meetingPausedTotalMs: 0,
  systemAudioWarning: false,
  ...CLEARED_TRANSCRIPTION_LINK,
  transcriptionDropped: false,
  silencePromptAt: null,

  setSilencePrompt: (silencePromptAt) => set({ silencePromptAt }),
  adoptOrphanedRecording: () => {
    log.info("store: adopting an orphaned recording");
    set({ transcriptionDropped: true });
  },
  setSystemAudioWarning: (systemAudioWarning) => set({ systemAudioWarning }),
  reportTranscriptionLink: (source, linkState) =>
    set((state) => foldTranscriptionLink(state, source, linkState)),
  setFinalizingMeeting: (v) => set({ isFinalizingMeeting: v }),

  startMeeting: () => {
    log.info("store: meeting started");
    set({
      // Recording owns the window: land on the live cockpit.
      appMode: "live",
      meetingStatus: "recording",
      meetingStartedAt: Date.now(),
      meetingPausedAt: null,
      meetingPausedTotalMs: 0,
      loadedHistoryId: null,
      replayFolderId: null,
      segments: [],
      speakerNames: {},
      ...CLEARED_STUDY_SLICE,
      prosody: null,
      micSessionRateHz: null,
      filledPauseCount: 0,
      filledPauseCounted: {},
      deliveryNudge: null,
      systemAudioWarning: false,
      ...CLEARED_TRANSCRIPTION_LINK,
      transcriptionDropped: false,
      silencePromptAt: null,
    });
  },

  pauseMeeting: () => {
    log.info("store: meeting paused");
    set((s) =>
      s.meetingStatus === "recording"
        ? { meetingStatus: "paused", meetingPausedAt: Date.now(), silencePromptAt: null }
        : {}
    );
  },

  resumeMeeting: () => {
    log.info("store: meeting resumed");
    set((s) =>
      s.meetingStatus === "paused"
        ? {
            meetingStatus: "recording",
            meetingPausedAt: null,
            meetingPausedTotalMs:
              s.meetingPausedTotalMs + Math.max(0, Date.now() - (s.meetingPausedAt ?? Date.now())),
          }
        : {}
    );
  },

  cancelMeeting: () => {
    log.info("store: meeting cancelled");
    set({
      // Back home with the prep INTACT: cancelling is "wrong mic / wrong
      // moment, let me fix it and start again", not "throw my setup away"
      // (clearing is resetPrep, an explicit act).
      appMode: "home",
      meetingStatus: "idle",
      meetingStartedAt: null,
      meetingPausedAt: null,
      meetingPausedTotalMs: 0,
      segments: [],
      speakerNames: {},
      ...CLEARED_STUDY_SLICE,
      prosody: null,
      micSessionRateHz: null,
      filledPauseCount: 0,
      filledPauseCounted: {},
      deliveryNudge: null,
      // A cancelled meeting saves nothing, so nothing downstream reads these.
      ...CLEARED_TRANSCRIPTION_LINK,
      transcriptionDropped: false,
      silencePromptAt: null,
    });
  },

  stopMeeting: () => {
    log.info("store: meeting stopped");
    set({
      meetingStatus: "stopped",
      meetingPausedAt: null,
      prosody: null,
      deliveryNudge: null,
      // The backend stops redialling with the meeting, so a banner left up
      // here would never clear. `transcriptionDropped` stays: the save that
      // runs after stop reads it.
      ...CLEARED_TRANSCRIPTION_LINK,
      silencePromptAt: null,
    });
  },
});
