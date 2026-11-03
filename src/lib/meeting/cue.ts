import { useStore } from "../store";
import * as ipc from "../ipc/commands";
import { isTauri } from "../platform";
import { log } from "../log";

/**
 * The short system sound a meeting recording — and a voice-typing dictation —
 * starts and stops with (issue #607), so the user knows Parley is listening
 * without looking at it. The sound itself is the OS's own (commands/cue.rs);
 * this decides whether to play it. Pause and resume stay silent.
 *
 * A meeting recording only sounds its end (it starts without a cue), and the
 * setting silences that. A dictation is short and started blind from a
 * hotkey, so both its cues always play.
 */
export type RecordingCue = "start" | "stop";

/**
 * Play `cue` if the setting allows it. Never throws: a sound that fails to
 * play is not worth failing a start or an end over. Resolves to whether it
 * was asked to play.
 */
export async function playCue(cue: RecordingCue): Promise<boolean> {
  if (!useStore.getState().settings.recordingCueEnabled) return false;
  return play(cue);
}

/** Play a voice-typing cue: always on, whatever the recording setting says. */
export function playVoiceTypingCue(cue: RecordingCue): Promise<boolean> {
  return play(cue);
}

async function play(cue: RecordingCue): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await ipc.playCue({ cue });
    return true;
  } catch (error) {
    log.warn("meeting: recording cue failed", { cue, error: String(error) });
    return false;
  }
}
