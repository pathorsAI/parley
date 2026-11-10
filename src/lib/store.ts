// The one Parley store. A single zustand store (persisted under
// "parley-settings": settings + the cloud sign-in) composed from one slice
// creator per concern in ./store/. Everything the app imports from here — the
// `useStore` hook, its state and actions, the shared types and the pure
// helpers that used to live in this file — keeps its name and its import path.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PERSIST_OPTIONS } from "./store/persistence";
import { createNavSlice } from "./store/nav";
import { createReplaySlice } from "./store/replay";
import { createIngestSlice } from "./store/ingest";
import { createStudySlice } from "./store/study";
import { createMeetingSlice } from "./store/meeting";
import { createSegmentsSlice } from "./store/segments";
import { createCoachingSlice } from "./store/coaching";
import { createPrepSlice } from "./store/prep";
import { createSettingsSlice } from "./store/settings";
import { createAuthSlice } from "./store/auth";
import { createSpeakersSlice } from "./store/speakers";
import { isMeetingActive } from "./store/meeting";
import { setLiveMeetingProbe } from "./store/liveProbe";
import type { ParleyState, StoreGet, StoreSet } from "./store/types";

/** Every slice, composed over one set/get. Both stores below are built from
 *  it, so the live meeting runs on exactly the actions it always has. */
function allSlices(set: StoreSet, get: StoreGet): ParleyState {
  return {
    ...createNavSlice(set, get),
    ...createReplaySlice(set, get),
    ...createIngestSlice(set, get),
    ...createStudySlice(set, get),
    ...createMeetingSlice(set, get),
    ...createSegmentsSlice(set, get),
    ...createCoachingSlice(set, get),
    ...createPrepSlice(set, get),
    ...createSettingsSlice(set, get),
    ...createAuthSlice(set, get),
    ...createSpeakersSlice(set, get),
  };
}

/**
 * The main window's store: settings, drafts, the library and navigation, and
 * the recording the window is showing (replay / study). It does NOT hold the
 * running meeting — that lives in {@link useLiveStore} — so opening, studying
 * or importing a recording during a meeting can never touch the meeting, and
 * the meeting can never overwrite what this window shows.
 */
export const useStore = create<ParleyState>()(persist((set, get) => allSlices(set, get), PERSIST_OPTIONS));

/**
 * The RUNNING meeting, in the main window: its lifecycle and clock, the
 * transcription link, the transcript and speaker names, the live coaching
 * signals, the live findings, and the prep it was started with (title, notes,
 * context, negotiation setup, destination, agenda). Not persisted.
 *
 * Same shape as {@link useStore} (built from the same slice creators), so the
 * meeting's actions — startMeeting, upsertSegment, setProsody, … — are the ones
 * the app always had. Only these meeting fields are meaningful here; the rest
 * (appMode, replay, drafts, …) stay at their defaults and nothing reads them.
 * `settings` is a read-only mirror of useStore's, kept current below, so a
 * slice action that reads `settings` (the language, say) sees the real ones;
 * settings are only ever edited through useStore.
 *
 * The floating meeting window is a separate webview: there the meeting is
 * mirrored into that window's own useStore (see meeting/meetingWindow.ts).
 */
export const useLiveStore = create<ParleyState>()((set, get) => allSlices(set, get));

// Keep the live store's settings mirror current — including persist's hydrate
// and every settings sync from the Settings window.
useLiveStore.setState({ settings: useStore.getState().settings, evaluations: useStore.getState().evaluations });
useStore.subscribe((s, p) => {
  if (s.settings !== p.settings || s.evaluations !== p.evaluations) {
    useLiveStore.setState({ settings: s.settings, evaluations: s.evaluations });
  }
});

/** Is a meeting recording (or paused) right now? THE check behind "one meeting
 *  at a time" — it reads the live store, never the window's own. */
export function isLiveMeetingActive(): boolean {
  return isMeetingActive(useLiveStore.getState().meetingStatus);
}
setLiveMeetingProbe(isLiveMeetingActive);

export type {
  AppMode,
  AsyncTaskStatus,
  LibrarySelection,
  ReplayTrim,
  SettingsCategory,
  TranscriptionLink,
} from "./store/types";
export {
  ALL_HINT_IDS,
  DEFAULT_GETTING_STARTED,
  DEFAULT_VOICE_TYPING_SHORTCUT,
} from "./store/defaults";
export {
  PERSIST_VERSION,
  mergePersistedState,
  migrateLlmSettings,
  migratePersistedState,
  migrateVoiceTypingPolishStyle,
  migrateVoiceTypingShortcut,
} from "./store/persistence";
export { restoredStudyStatuses } from "./store/study";
export { isMeetingActive, meetingElapsedMs } from "./store/meeting";
export { setSettingsBroadcaster, settingsBroadcastSettled } from "./store/settings";
export { isTrimmed, hasSpokenSegment } from "./replay/keepWindow";
export { speakerKey, defaultSpeakerLabel, speakerLabel } from "./speakers/labels";
export {
  formatClock,
  transcriptAsText,
  transcriptPlainText,
  transcriptWithTimestamps,
} from "./analysis/transcriptText";
export { meetingBriefText } from "./meeting/brief";
