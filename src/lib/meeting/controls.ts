import { useStore } from "../store";
import { stopMockStream } from "../mockStream";
import { meetingUsesRealPipeline } from "../transcription/prepare";
import { log } from "../log";
import * as ipc from "../ipc/commands";

/**
 * The live meeting's recorder controls — end, pause/resume, cancel — and the
 * backend stop the other teardown paths share. Each flips the store first
 * (instant UI), then tells whichever pipeline the meeting runs on: the Rust
 * capture session, or (dev build, no credential) the mock stream. Which one is
 * the same question `beginMeeting` asked: {@link meetingUsesRealPipeline}.
 *
 * The callers own their re-entrancy guard (the titlebar's busy flag).
 */

/**
 * Tell the backend to stop the capture session, best-effort: `stop_meeting`
 * is idempotent, so a teardown that may race another (a backend error, the
 * window closing) just sends it. A failure is logged as `failureLog`.
 */
export function stopBackendMeeting(failureLog: string, fields: Record<string, unknown> = {}): Promise<void> {
  return ipc.stopMeeting().catch((error) => log.warn(failureLog, { ...fields, error: String(error) }));
}

/**
 * End = the meeting's natural finish: save the recording, then the study
 * pipeline runs the debrief.
 */
export async function endMeeting(): Promise<void> {
  log.info("meeting: stop requested");
  const store = useStore.getState();
  const real = meetingUsesRealPipeline(store.settings);
  store.stopMeeting();
  if (!real) {
    stopMockStream();
    return;
  }
  // The real save runs async off the `recording-saved` event and takes
  // seconds (encode → persist → open the report). Flag "finalizing" now so the
  // button shows a spinner for that window instead of reading as hung (it also
  // keeps the shell's focused layout up until the report replaces the
  // cockpit). Cleared the moment the report opens — speaker correction and the
  // org share continue in the background — or when the save fails or Rust
  // reports the recording was discarded (see saveLiveToHistory /
  // listenForRecordingSaved).
  store.setFinalizingMeeting(true);
  try {
    await ipc.stopMeeting();
  } catch (e) {
    log.error("meeting: stop failed", { error: String(e) });
    useStore.getState().setFinalizingMeeting(false);
  }
}

/**
 * Pause/resume flips the store first (instant UI) then tells the backend to
 * drop/readmit audio. The backend flag is idempotent, so no busy guard.
 */
export function toggleMeetingPause(): void {
  const store = useStore.getState();
  const paused = store.meetingStatus === "paused";
  if (paused) {
    log.info("meeting: resume requested");
    store.resumeMeeting();
  } else {
    log.info("meeting: pause requested");
    store.pauseMeeting();
  }
  if (meetingUsesRealPipeline(store.settings)) {
    ipc.setMeetingPaused({ paused: !paused }).catch((e) =>
      log.error("meeting: pause toggle failed", { error: String(e) }),
    );
  }
}

/** Cancel: discard everything (the backend drops the recording instead of
 *  encoding it), back to idle. */
export async function cancelActiveMeeting(): Promise<void> {
  log.info("meeting: cancel requested");
  const store = useStore.getState();
  const real = meetingUsesRealPipeline(store.settings);
  store.cancelMeeting();
  if (!real) {
    stopMockStream();
    return;
  }
  try {
    await ipc.cancelMeeting();
  } catch (e) {
    log.error("meeting: cancel failed", { error: String(e) });
  }
}
