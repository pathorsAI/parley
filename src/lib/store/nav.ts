// Shell navigation: which route is on screen, what the library shows, and the
// transcript moment the UI should jump to.

import { isMeetingActive } from "./meeting";
import type { AppMode, LibrarySelection, SliceCreator } from "./types";

export interface NavSlice {
  /**
   * "live" = capturing mic/system audio now; "replay" = analyzing an uploaded
   * recording. In replay mode the uploaded transcript is loaded into `segments`,
   * so every panel (transcript, findings, ask, report) works unchanged; the
   * playhead is for navigation/viewing only (no masking).
   */
  appMode: AppMode;
  /** Show the Home overview (idle landing — blocked while recording). */
  openHome: () => void;
  /** Show the recordings library at `selection` (blocked while recording). */
  openLibrary: (selection: LibrarySelection) => void;
  librarySelection: LibrarySelection;
  /** Go back to the recording that is already loaded. Navigating the tree away
   *  from a loaded recording used to strand it: nothing on screen still pointed
   *  at it, and only exitReplay (which THROWS IT AWAY) was reachable. */
  showReplay: () => void;

  /**
   * A transcript time (ms) the UI should jump to and briefly highlight — set by
   * clicking a timestamp in the debrief. Generic on purpose: a future recording
   * player could consume the same signal. Consumers clear it after handling.
   */
  highlightMs: number | null;
  setHighlightMs: (ms: number | null) => void;
}

export const createNavSlice: SliceCreator<NavSlice> = (set) => ({
  appMode: "home",
  librarySelection: { kind: "personal", node: { kind: "unassigned" } },
  highlightMs: null,

  openHome: () =>
    set((s) => (isMeetingActive(s.meetingStatus) ? {} : { appMode: "home" })),
  openLibrary: (librarySelection) =>
    set((s) =>
      isMeetingActive(s.meetingStatus) ? {} : { appMode: "library", librarySelection }
    ),
  showReplay: () => set((s) => (s.replay ? { appMode: "study" } : {})),
  setHighlightMs: (ms) => set({ highlightMs: ms }),
});
