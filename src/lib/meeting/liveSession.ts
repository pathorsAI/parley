// The hand-over between the main window's prep (useStore) and the running
// meeting (useLiveStore), and the hook that reads the running meeting from
// whichever window a component renders in.

import { useLiveStore, useStore } from "../store";
import { CLEARED_PREP_SLICE, DEFAULT_REMINDER_LEAD_MIN } from "../store/prep";
import { consumeDraftTaken } from "../store/liveProbe";
import type { ParleyState } from "../store/types";
import { log } from "../log";

/**
 * What a meeting takes from the prep when it starts: everything set up FOR it,
 * plus the auto-analysis toggle. From then on the meeting's copy is the one the
 * floating window edits and the save files by; the main window's prep is free
 * again (a new draft, a draft being edited) and nothing done there reaches the
 * meeting.
 */
const PREP_KEYS = [
  "meetingTitle",
  "meetingNotes",
  "meetingContext",
  "meetingBatna",
  "meetingTarget",
  "meetingFloor",
  "meetingFolderId",
  "meetingOrgShare",
  "meetingAt",
  "meetingEndAt",
  "todos",
  "autoAnalyze",
  "autoAnalyzeSec",
] as const satisfies readonly (keyof ParleyState)[];

/** The prep fields a loaded recording also uses for its own context
 *  (store/replay.ts loadHistory). */
const RECORDING_OWNED = ["meetingContext", "meetingFolderId", "meetingBatna", "meetingTarget", "meetingFloor"] as const;

type Prep = Pick<ParleyState, (typeof PREP_KEYS)[number]>;

function pickPrep(s: ParleyState): Prep {
  const out = {} as Record<string, unknown>;
  for (const k of PREP_KEYS) out[k] = s[k];
  return out as Prep;
}

/** The main window's prep is untouched since the meeting took it: empty, and
 *  no draft open or being edited. Only then may a backed-out meeting put its
 *  prep back without overwriting something the user did meanwhile. */
function mainPrepIsEmpty(s: ParleyState): boolean {
  if (s.editingDraftId != null || s.draftOpen) return false;
  return (Object.keys(CLEARED_PREP_SLICE) as (keyof typeof CLEARED_PREP_SLICE)[]).every((k) => {
    const v = s[k];
    return Array.isArray(v) ? v.length === 0 : v === CLEARED_PREP_SLICE[k];
  });
}

/**
 * Start the live meeting: move the prep into the live store, then start it
 * there. The main window's route, its loaded recording and its own prep
 * fields are left as they are — apart from the prep, which the meeting took.
 */
export function beginLiveSession(): void {
  const main = useStore.getState();
  const prep = pickPrep(main);
  const fromDraft = consumeDraftTaken();
  // A loaded recording keeps its own context in these prep fields (loadHistory
  // writes them, the study page edits them): the recording on screen must not
  // lose them, and a new meeting must not inherit another recording's context
  // — unless a draft was just taken, whose prep is what's there now.
  const keep = main.replay ? RECORDING_OWNED : [];
  if (main.replay && !fromDraft) {
    for (const k of RECORDING_OWNED) (prep as Record<string, unknown>)[k] = CLEARED_PREP_SLICE[k];
  }
  const cleared: Record<string, unknown> = {
    ...CLEARED_PREP_SLICE,
    reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
    editingDraftId: null,
  };
  for (const k of keep) delete cleared[k];
  useStore.setState(cleared as Partial<ParleyState>);
  useLiveStore.setState(prep);
  useLiveStore.getState().startMeeting();
}

/**
 * A meeting that never really happened (cancelled, or a start the backend
 * refused) gives its prep back, so "fix the mic and start again" finds it
 * where it was — unless the user has started on another draft meanwhile.
 */
function returnPrep(): void {
  if (!mainPrepIsEmpty(useStore.getState())) {
    log.info("meeting: prep not returned, the main window's prep is in use");
    return;
  }
  useStore.setState(pickPrep(useLiveStore.getState()));
}

/** Cancel the live meeting (store side) and return its prep. */
export function cancelLiveSession(): void {
  // cancelMeeting keeps the meeting's prep fields, so they can go back.
  useLiveStore.getState().cancelMeeting();
  returnPrep();
}

/** A start that failed before anything was recorded: stop it, return the prep. */
export function backOutOfStart(): void {
  useLiveStore.getState().stopMeeting();
  returnPrep();
}

/** True in the floating meeting window, whose own useStore mirrors the meeting. */
function inMeetingWindow(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.appWindow === "meeting";
}

/**
 * Read the running meeting in a component that renders in BOTH windows (the
 * mic chip, the transcript…): the main window holds it in useLiveStore, the
 * floating meeting window in its own mirrored useStore. The window never
 * changes under a mounted component, so the hook order is stable.
 */
export function useLiveMeeting<T>(selector: (s: ParleyState) => T): T {
  const store = inMeetingWindow() ? useStore : useLiveStore;
  return store(selector);
}
