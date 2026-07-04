import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useStore } from "./store";
import { toTraditional } from "./zhConvert";
import { translate, type TranslationKey } from "../i18n/messages";
import type { Source } from "./types";

/** Shape of the `transcript://segment` payload emitted by the Rust backend. */
interface TranscriptEventPayload {
  id: string;
  source: Source;
  speaker: number;
  text: string;
  is_final: boolean;
  start_ms: number;
  end_ms: number;
}

/**
 * Subscribe to backend transcript events and feed them into the store. Returns
 * an unlisten function; call it on teardown. Safe to call when not running under
 * Tauri (e.g. plain `vite` in a browser) — it just resolves to a no-op.
 */
export async function listenForTranscript(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  return listen<TranscriptEventPayload>("transcript://segment", (event) => {
    const p = event.payload;
    // Voice-typing dictation streams over the same event but belongs to the
    // floating overlay, not the meeting transcript — keep it out of the store.
    if ((p.source as string) === "voice-typing") return;
    void toTraditional(p.text).then((text) => {
      useStore.getState().upsertSegment({
        id: p.id,
        source: p.source,
        speaker: p.speaker,
        text,
        isFinal: p.is_final,
        startMs: p.start_ms,
        endMs: p.end_ms,
      });
    });
  });
}

/** Shape of the `audio://prosody` payload (snake_case on the wire). */
interface ProsodyEventPayload {
  source: Source;
  f0_hz: number;
  pitch_var_semitones: number;
  monotony_score: number;
  speech_rate_hz: number;
  voiced_ratio: number;
  silence_ms: number;
  longest_pause_ms: number;
  speaking: boolean;
  filled_pause: boolean;
}

/**
 * Subscribe to backend prosody events (live delivery coaching on the "me" mic)
 * and feed them into the store. Mirrors {@link listenForTranscript}; no-op
 * outside Tauri. Only "me" is ever emitted, but we filter defensively.
 */
export async function listenForProsody(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  return listen<ProsodyEventPayload>("audio://prosody", (event) => {
    const p = event.payload;
    if (p.source !== "me") return;
    useStore.getState().setProsody({
      f0Hz: p.f0_hz,
      pitchVarSemitones: p.pitch_var_semitones,
      monotonyScore: p.monotony_score,
      speechRateHz: p.speech_rate_hz,
      voicedRatio: p.voiced_ratio,
      silenceMs: p.silence_ms,
      longestPauseMs: p.longest_pause_ms,
      speaking: p.speaking,
      filledPause: p.filled_pause,
    });
  });
}

/** Shape of the `meeting://error` payload (a transcription session failed). */
interface MeetingErrorPayload {
  source: string;
  /** Hosted: "quota" (402) | "auth" (401 expired session). BYOK: "key"
   *  (rejected vendor key). Either: "capture" (no audio source) | "connect". */
  code: string;
  message: string;
}

/**
 * Subscribe to backend transcription-failure events. A meeting that loses its
 * STT session would otherwise sit in "recording" with no transcript and no
 * signal — especially in hosted mode, where 402 (out of credits) and 401
 * (expired session) are routine. Stop the meeting and surface an actionable
 * toast. No-op outside Tauri.
 */
export async function listenForMeetingError(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  return listen<MeetingErrorPayload>("meeting://error", (event) => {
    const { code } = event.payload;
    // Tear the (transcript-less) meeting down so the UI leaves "recording".
    useStore.getState().stopMeeting();
    void invoke("stop_meeting").catch(() => {});
    const key: TranslationKey =
      code === "quota"
        ? "meeting.error.quota"
        : code === "auth"
          ? "meeting.error.auth"
          : code === "key"
            ? "meeting.error.key"
            : code === "capture"
              ? "meeting.error.capture"
              : "meeting.error.connect";
    toast.error(translate(useStore.getState().settings.language, key));
  });
}

/** Shape of the `meeting://warning` payload (meeting keeps running). */
interface MeetingWarningPayload {
  /** "system-audio-silent" | "system-audio-unavailable" */
  code: string;
  message?: string;
}

/**
 * Subscribe to NON-fatal meeting warnings. Today that's the system-audio tap
 * reporting it can't deliver the other party's audio (usually the "System Audio
 * Recording" permission is missing) — the meeting continues mic-only, but the
 * user should know why the remote side produces no transcript. De-duped per
 * meeting via a module flag reset on each `meeting://status` change.
 */
let warnedSystemAudio = false;
export async function listenForMeetingWarning(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  const unStatus = await listen<string>("meeting://status", () => {
    warnedSystemAudio = false;
  });
  const unWarn = await listen<MeetingWarningPayload>("meeting://warning", (event) => {
    const { code } = event.payload;
    if (code !== "system-audio-silent" && code !== "system-audio-unavailable") return;
    if (warnedSystemAudio) return;
    warnedSystemAudio = true;
    toast.warning(
      translate(useStore.getState().settings.language, "meeting.warning.systemAudio"),
      { duration: 10000 },
    );
  });
  return () => {
    unStatus();
    unWarn();
  };
}

/** True when running inside the Tauri shell (vs a plain browser dev session). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
