import * as ipc from "../ipc/commands";
import { isTauri } from "../platform";
import { log } from "../log";

/**
 * The short system sound a voice-typing dictation starts and stops with
 * (issue #607): it is started blind from a hotkey, so the sound is how the
 * user knows Parley is listening. The sound itself is the OS's own
 * (commands/cue.rs). Meeting recordings play no cue at either end.
 */
export type RecordingCue = "start" | "stop";

/**
 * Play a voice-typing cue. Never throws: a sound that fails to play is not
 * worth failing a dictation over. Resolves to whether it played.
 */
export async function playVoiceTypingCue(cue: RecordingCue): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await ipc.playCue({ cue });
    return true;
  } catch (error) {
    log.warn("voice-typing: cue failed", { cue, error: String(error) });
    return false;
  }
}
