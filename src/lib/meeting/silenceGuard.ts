// The silence guard: a meeting nobody is talking in any more gets asked
// whether it is over, and ends itself if nobody answers.
//
// A meeting only stops when someone presses End. Leave the call without
// pressing it and Parley keeps recording — and a Mac that is recording audio
// never idle-sleeps, so it records the empty room until someone comes back:
// an hour-long meeting saved as a 9-hour file whose last 8 hours are silence
// with no transcript. The guard watches the transcript instead of the audio
// level (a quiet room is never digitally silent): once nothing has been
// transcribed for SILENCE_PROMPT_MS it raises the live screen's banner and
// bounces the Dock icon, and after SILENCE_GRACE_MS more without an answer it
// ends the meeting, saving the recording cut a little after the last words.

import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { isMeetingActive, useStore } from "../store";
import type { TranscriptSegment } from "../types";
import { isTauri } from "../platform";
import { log } from "../log";
import { notify } from "../notify";
import { translate } from "../../i18n/messages";
import { endMeeting } from "./controls";

/** Nothing transcribed for this long → ask whether the meeting is over. */
export const SILENCE_PROMPT_MS = 15 * 60_000;
/** Unanswered for this long after asking → end the meeting. */
export const SILENCE_GRACE_MS = 2 * 60_000;
/** Recording kept past the last transcribed word when the guard ends it. */
export const TRIM_MARGIN_MS = 30_000;
/** How often the guard looks. Coarse on purpose: it measures minutes. */
const TICK_MS = 5_000;

export type SilenceStep = "none" | "prompt" | "dismiss" | "end";

/**
 * What the guard does at `now`, given when speech was last seen and when it
 * asked (null = not asking). Speech after the question withdraws it; silence
 * through the whole grace ends the meeting. Pure.
 */
export function silenceStep(now: number, lastActivityAt: number, promptAt: number | null): SilenceStep {
  if (promptAt == null) return now - lastActivityAt >= SILENCE_PROMPT_MS ? "prompt" : "none";
  if (lastActivityAt > promptAt) return "dismiss";
  return now - promptAt >= SILENCE_GRACE_MS ? "end" : "none";
}

/**
 * How much of the recording to keep when the guard ends a meeting: up to the
 * end of the last transcribed words plus TRIM_MARGIN_MS, on the recording's own
 * timeline (segment times are recorded time, so a Mac that slept mid-meeting
 * does not shift them). Undefined when nothing was ever said — then there is
 * nothing to anchor a cut to, and the save keeps or skips it as usual.
 */
export function recordingKeepMs(segments: TranscriptSegment[]): number | undefined {
  let last = -1;
  for (const seg of segments) {
    if (seg.text.trim() && seg.endMs > last) last = seg.endMs;
  }
  return last < 0 ? undefined : last + TRIM_MARGIN_MS;
}

/** Did this store update bring transcribed words (a new or grown segment)? */
export function broughtSpeech(prev: TranscriptSegment[], next: TranscriptSegment[]): boolean {
  if (next === prev) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== prev[i] && next[i].text.trim()) return true;
  }
  return false;
}

/** End the meeting the guard asked about, trimmed after its last words. */
export async function endSilentMeeting(reason: "timeout" | "confirmed"): Promise<void> {
  const s = useStore.getState();
  if (!isMeetingActive(s.meetingStatus)) return;
  const keepMs = recordingKeepMs(s.segments);
  log.info("meeting: ended by the silence guard", { reason, keepMs });
  s.setSilencePrompt(null);
  await endMeeting(keepMs == null ? {} : { keepMs });
  if (reason === "timeout") notify.message(translate(s.settings.language, "meeting.silence.autoEnded"));
}

let lastActivityAt = Date.now();

/** The banner's "keep recording": count it as activity and stop asking. */
export function keepRecording(): void {
  log.info("meeting: silence prompt answered, still in the meeting");
  lastActivityAt = Date.now();
  useStore.getState().setSilencePrompt(null);
}

function askUser(): void {
  if (!isTauri()) return;
  // Bounces the Dock icon until Parley is focused — the user is likely in
  // another app, or away from the desk.
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Critical)
    .catch((error) => log.warn("meeting: silence prompt attention request failed", { error: String(error) }));
}

/**
 * Run the guard for this window (the main window, once). Returns its teardown.
 * Only a RECORDING meeting with a live transcription link is watched: a pause
 * is the user's own silence, and while the link is reconnecting nothing gets
 * transcribed however much is said — both restart the clock instead.
 */
export function initSilenceGuard(): () => void {
  const unsubscribe = useStore.subscribe((next, prev) => {
    const entered = next.meetingStatus === "recording" && prev.meetingStatus !== "recording";
    if (entered || broughtSpeech(prev.segments, next.segments)) lastActivityAt = Date.now();
  });
  const timer = setInterval(() => {
    const s = useStore.getState();
    const now = Date.now();
    if (s.meetingStatus !== "recording" || s.isFinalizingMeeting) return;
    if (s.transcriptionLink !== "live") {
      lastActivityAt = now;
      if (s.silencePromptAt != null) s.setSilencePrompt(null);
      return;
    }
    switch (silenceStep(now, lastActivityAt, s.silencePromptAt)) {
      case "prompt":
        log.info("meeting: nothing transcribed for a while, asking whether it is over", {
          silentMs: now - lastActivityAt,
        });
        s.setSilencePrompt(now);
        askUser();
        break;
      case "dismiss":
        log.info("meeting: speech resumed, silence prompt withdrawn");
        s.setSilencePrompt(null);
        break;
      case "end":
        void endSilentMeeting("timeout").catch((error) =>
          log.error("meeting: silence guard end failed", { error: String(error) }),
        );
        break;
      case "none":
        break;
    }
  }, TICK_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
