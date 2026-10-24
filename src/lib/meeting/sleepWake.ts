// A meeting the computer slept through ends when it wakes.
//
// Closing the lid mid-meeting used to leave the meeting recording: capture
// resumed on wake, and a meeting left running overnight absorbed the next
// morning's into one file (one desktop: created 20:47, updated 14:56 the next
// day, ~6 h of awake audio, near-empty transcript). The backend's heartbeat
// (sleep_watch.rs) reports every wake with how long the machine was gone;
// past WAKE_END_AFTER_MS the meeting is over — it is ended and saved as it
// stood when the machine went to sleep, and the user is told.

import { isMeetingActive, useStore } from "../store";
import { listenIfTauri, SYSTEM_WAKE_EVENT, type UnlistenFn } from "../ipc/events";
import { log } from "../log";
import { notify } from "../notify";
import { translate } from "../../i18n/messages";
import { endMeeting } from "./controls";

/** Asleep at least this long → the meeting that was recording is over. */
export const WAKE_END_AFTER_MS = 30 * 60_000;

/** Does a wake after `sleptMs` end the meeting in `status`? Pure. */
export function endsMeetingOnWake(sleptMs: number, status: Parameters<typeof isMeetingActive>[0]): boolean {
  return isMeetingActive(status) && sleptMs >= WAKE_END_AFTER_MS;
}

/** React to one wake report. */
export async function handleSystemWake(sleptMs: number): Promise<void> {
  const s = useStore.getState();
  if (!endsMeetingOnWake(sleptMs, s.meetingStatus)) {
    if (isMeetingActive(s.meetingStatus)) log.info("meeting: the computer slept briefly mid-meeting", { sleptMs });
    return;
  }
  log.warn("meeting: the computer slept through the meeting; ending and saving it", {
    sleptMs,
    status: s.meetingStatus,
  });
  s.setSilencePrompt(null);
  // No trim: the recording has nothing from the sleep itself, and the last
  // minutes before it may hold words a dropped link never transcribed.
  await endMeeting();
  notify.message(
    translate(s.settings.language, "meeting.wake.autoEnded", { minutes: Math.round(sleptMs / 60_000) }),
  );
}

/** Main-window listener (once). */
export function listenForSystemWake(): Promise<UnlistenFn> {
  return listenIfTauri(SYSTEM_WAKE_EVENT, (e) => {
    void handleSystemWake(e.payload.sleptMs).catch((error) =>
      log.error("meeting: ending a meeting after wake failed", { error: String(error) }),
    );
  });
}
