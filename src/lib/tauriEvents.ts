import { toast } from "sonner";
import { useStore } from "./store";
import { normalizeTranscriptText } from "./textNormalize";
import { log } from "./log";
import { translate } from "../i18n/messages";
import type { Source } from "./types";
import { isLocalFailureCode, showLocalFailureToast } from "./transcription/localAlerts";
import { failureMessageKey } from "./transcription/errors";
import { stopBackendMeeting } from "./meeting/controls";
import {
  AUDIO_PROSODY_EVENT,
  MEETING_ERROR_EVENT,
  MEETING_STATUS_EVENT,
  MEETING_TRANSCRIPTION_EVENT,
  MEETING_WARNING_EVENT,
  TRANSCRIPT_SEGMENT_EVENT,
  listenIfTauri,
  type UnlistenFn,
} from "./ipc/events";

/**
 * Subscribe to backend transcript events and feed them into the store. Returns
 * an unlisten function; call it on teardown. Safe to call when not running under
 * Tauri (e.g. plain `vite` in a browser) — it just resolves to a no-op.
 */
export async function listenForTranscript(): Promise<UnlistenFn> {
  return listenIfTauri(TRANSCRIPT_SEGMENT_EVENT, (event) => {
    const p = event.payload;
    // Voice-typing dictation streams over the same event but belongs to the
    // floating overlay, not the meeting transcript — keep it out of the store.
    if (p.source === "voice-typing") return;
    normalizeTranscriptText(p.text)
      .then((text) => {
        useStore.getState().upsertSegment({
          id: p.id,
          // A meeting's segments are "me" | "them".
          source: p.source as Source,
          speaker: p.speaker,
          text,
          isFinal: p.is_final,
          startMs: p.start_ms,
          endMs: p.end_ms,
        });
      })
      .catch((error) => {
        log.warn("transcript: conversion failed", { segmentId: p.id, error: String(error) });
      });
  });
}

/**
 * Subscribe to backend prosody events (live delivery coaching on the "me" mic)
 * and feed them into the store. Mirrors {@link listenForTranscript}; no-op
 * outside Tauri. Only "me" is ever emitted, but we filter defensively.
 */
export async function listenForProsody(): Promise<UnlistenFn> {
  return listenIfTauri(AUDIO_PROSODY_EVENT, (event) => {
    const p = event.payload;
    if (p.source !== "me") return;
    useStore.getState().setProsody({
      f0Hz: p.f0_hz,
      pitchVarSemitones: p.pitch_var_semitones,
      monotonyScore: p.monotony_score,
      speechRateHz: p.speech_rate_hz,
      sessionRateHz: p.session_rate_hz,
      voicedRatio: p.voiced_ratio,
      silenceMs: p.silence_ms,
      longestPauseMs: p.longest_pause_ms,
      speaking: p.speaking,
      filledPause: p.filled_pause,
      farendActive: p.farend_active,
    });
  });
}

/**
 * Subscribe to backend transcription-FAILURE events — the ones a redial can't
 * fix. Hosted mode makes 402 (out of credits) and 401 (expired session)
 * routine; a rejected BYOK key and a capture that never started are just as
 * final. A meeting stuck in any of them would otherwise sit in "recording"
 * with no transcript and no signal, so stop it and surface an actionable toast.
 *
 * A dropped connection is NOT one of them any more (#570): the backend keeps
 * the mic recording and redials, reporting progress on `meeting://transcription`
 * (see {@link listenForTranscriptionLink}). "connect" stays mapped for a
 * backend that still sends it, but a network blip mid-meeting no longer lands
 * here. No-op outside Tauri.
 */
export async function listenForMeetingError(): Promise<UnlistenFn> {
  return listenIfTauri(MEETING_ERROR_EVENT, (event) => {
    const { code } = event.payload;
    // Tear the (transcript-less) meeting down so the UI leaves "recording".
    useStore.getState().stopMeeting();
    void stopBackendMeeting("meeting: stop after backend error failed", { code });
    const language = useStore.getState().settings.language;
    // On-device failures point at Settings › Transcription (a smaller model,
    // or the missing download) instead of the generic "can't connect".
    if (isLocalFailureCode(code)) {
      showLocalFailureToast(language, code);
      return;
    }
    // Unmapped codes fall back to "connect" (lib/transcription/errors.ts).
    toast.error(translate(language, failureMessageKey("meeting", code)));
  });
}

/**
 * Subscribe to the live transcript's link health (#570). Losing the network
 * mid-meeting used to end the whole recording; now the backend keeps the mic
 * recording, buffers what it can across the gap and redials with backoff —
 * the way iOS and Android already behave. This mirrors that into the store,
 * which drives the live screen's "reconnecting…" banner and makes the save
 * keep a recording whose transcript was cut short. A meeting may run two
 * sessions ("me" + "them" when diarization is off); the store holds the link
 * as reconnecting until every source that dropped is back. No-op outside Tauri.
 */
export async function listenForTranscriptionLink(): Promise<UnlistenFn> {
  return listenIfTauri(MEETING_TRANSCRIPTION_EVENT, (event) => {
    const p = event.payload;
    const store = useStore.getState();
    if (p.state === "reconnecting") {
      log.info("meeting: transcription reconnecting", { source: p.source, attempt: p.attempt });
      store.reportTranscriptionLink(p.source, "reconnecting");
      return;
    }
    if (p.state === "no_audio") {
      log.warn("meeting: no audio is being captured, transcription waits for it", { source: p.source });
      store.reportTranscriptionNoAudio(p.source);
      return;
    }
    if (p.state !== "live") return;
    // Log only the transition back, not every leg's first handshake.
    const wasReconnecting = store.transcriptionReconnectingSources.includes(p.source);
    store.reportTranscriptionLink(p.source, "live");
    if (wasReconnecting) {
      log.info("meeting: transcription live again", {
        source: p.source,
        leg: p.leg,
        stillReconnecting: useStore.getState().transcriptionReconnectingSources,
      });
    }
  });
}

/**
 * Subscribe to NON-fatal meeting warnings. Today that's the system-audio
 * capture reporting it can't deliver the other party's audio (macOS: usually
 * the "System Audio Recording" permission is missing; Windows: no output
 * device could be looped back) — the meeting continues mic-only, but the user
 * should know why the remote side produces no transcript. De-duped per
 * meeting via a module flag reset on each `meeting://status` change.
 */
let warnedSystemAudio = false;
export async function listenForMeetingWarning(): Promise<UnlistenFn> {
  const unStatus = await listenIfTauri(MEETING_STATUS_EVENT, () => {
    warnedSystemAudio = false;
  });
  const unWarn = await listenIfTauri(MEETING_WARNING_EVENT, (event) => {
    const { code } = event.payload;
    if (code !== "system-audio-silent" && code !== "system-audio-unavailable") return;
    if (warnedSystemAudio) return;
    warnedSystemAudio = true;
    // A persistent live-screen banner, not a toast (⑥): the damage — a silent
    // counterpart — is only noticed minutes later, long after 10s expire.
    useStore.getState().setSystemAudioWarning(true);
  });
  return () => {
    unStatus();
    unWarn();
  };
}

/** True when running inside the Tauri shell (vs a plain browser dev session).
 *  Defined in lib/platform.ts (which nothing else in the app imports, so it is
 *  safe for modules that need it at import time) and re-exported here because
 *  most of the app has always reached for it through this module. */
export { isTauri } from "./platform";
