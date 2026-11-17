import { useStore } from "../store";
import { notify } from "../notify";
import { translate } from "../../i18n/messages";
import { liveSaves } from "../history/history";
import { log } from "../log";

/** Rust → main window: quit, after ending and saving a live meeting (⌘Q, the
 *  app menu's Quit, the Windows tray's Quit — see src-tauri/src/quit.rs). */
export const QUIT_REQUESTED_EVENT = "app://quit-requested";

/**
 * How long Quit waits for a stopped meeting's history entry to land: the
 * encode of a long meeting plus the write. Shorter than the backend's own
 * fallback (SAVE_TIMEOUT in src-tauri/src/quit.rs), so the page exits on its
 * terms. A save cut short here is not lost outright: the crash journal still
 * holds the audio, and the next launch recovers it.
 */
export const QUIT_SAVE_WAIT_MS = 60_000;

/**
 * Quit, but never out from under a meeting: end an active one, wait for its
 * entry (transcript, recording, speakers) to be on disk, and only then exit.
 * Quitting used to exit the moment the stop IPC returned — and ⌘Q on macOS
 * did not even wait for that — so the transcript, which lives only in this
 * page until the save, died with the process. A saved entry needs nothing
 * more: its summary, action items and score run when it is next opened,
 * because the study pipeline picks up any stage that never ran.
 *
 * `endIfRecording` ends the live meeting (a no-op without one); `exit` quits
 * the process and runs whatever happened before it, failure included.
 */
export async function quitAfterSaving(
  endIfRecording: () => Promise<void>,
  exit: () => void,
  opts: { meetingActive: boolean; waitMs?: number },
): Promise<void> {
  try {
    if (opts.meetingActive || liveSaves.hasPending()) {
      log.info("quit: saving the meeting first");
      notify.message(translate(useStore.getState().settings.language, "meeting.quitSaving"));
    }
    await endIfRecording();
    if (liveSaves.hasPending()) {
      const saved = await liveSaves.whenSettled(opts.waitMs ?? QUIT_SAVE_WAIT_MS);
      if (!saved) log.warn("quit: the meeting was still saving; its crash journal will be recovered next launch");
    }
  } catch (error) {
    log.warn("quit: ending the meeting failed", { error: String(error) });
  } finally {
    exit();
  }
}
