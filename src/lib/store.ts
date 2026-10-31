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
import type { ParleyState } from "./store/types";

export const useStore = create<ParleyState>()(
  persist(
    (set, get) => ({
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
    }),
    PERSIST_OPTIONS,
  )
);

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
export { holdsLiveSession, isMeetingActive, meetingElapsedMs } from "./store/meeting";
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
