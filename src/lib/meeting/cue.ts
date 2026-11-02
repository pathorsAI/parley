import { useStore } from "../store";
import * as ipc from "../ipc/commands";
import { isTauri } from "../platform";
import { log } from "../log";

/**
 * The short system sound a meeting recording — and a voice-typing dictation —
 * starts and stops with (issue #607), so the user knows Parley is listening
 * without looking at it. The
 * sound itself is the OS's own (commands/cue.rs); this decides whether to
 * play it. Pause and resume stay silent.
 */
export type RecordingCue = "start" | "stop";

/**
 * How long Start lets the start cue play before the capture opens. The
 * system-audio capture is a tap of everything the Mac plays (Parley
 * included), and the mic hears the speakers, so a cue played into a running
 * capture would land in the recording. Ping strikes at once and then rings
 * out; by this point only its fading ring is left. Kept short because it
 * delays the start by as much.
 */
export const START_CUE_LEAD_MS = 400;

/**
 * Play `cue` if the setting allows it. Never throws: a sound that fails to
 * play is not worth failing a start or an end over. Resolves to whether it
 * was asked to play.
 */
export async function playCue(cue: RecordingCue): Promise<boolean> {
  if (!isTauri() || !useStore.getState().settings.recordingCueEnabled) return false;
  try {
    await ipc.playCue({ cue });
    return true;
  } catch (error) {
    log.warn("meeting: recording cue failed", { cue, error: String(error) });
    return false;
  }
}

/** The start cue, played before the capture opens so it is not recorded:
 *  resolves once its click has played (or at once when there is none). */
export async function playStartCue(): Promise<void> {
  if (await playCue("start")) {
    await new Promise((resolve) => setTimeout(resolve, START_CUE_LEAD_MS));
  }
}
