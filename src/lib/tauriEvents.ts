import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useStore } from "./store";
import { normalizeTranscriptText } from "./textNormalize";
import { log } from "./log";
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
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    return () => {};
  }
  return listen<TranscriptEventPayload>("transcript://segment", (event) => {
    const p = event.payload;
    // Voice-typing dictation streams over the same event but belongs to the
    // floating overlay, not the meeting transcript — keep it out of the store.
    if ((p.source as string) === "voice-typing") return;
    normalizeTranscriptText(p.text)
      .then((text) => {
        useStore.getState().upsertSegment({
          id: p.id,
          source: p.source,
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

/** Shape of the `audio://prosody` payload (snake_case on the wire). */
interface ProsodyEventPayload {
  source: Source;
  f0_hz: number;
  pitch_var_semitones: number;
  monotony_score: number;
  speech_rate_hz: number;
  session_rate_hz: number;
  voiced_ratio: number;
  silence_ms: number;
  longest_pause_ms: number;
  speaking: boolean;
  filled_pause: boolean;
  farend_active: boolean;
}

/**
 * Subscribe to backend prosody events (live delivery coaching on the "me" mic)
 * and feed them into the store. Mirrors {@link listenForTranscript}; no-op
 * outside Tauri. Only "me" is ever emitted, but we filter defensively.
 */
export async function listenForProsody(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in globalThis)) {
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

/** Shape of the `meeting://error` payload (a transcription session failed). */
interface MeetingErrorPayload {
  source: string;
  /** Hosted: "quota" (402) | "auth" (401 expired session). BYOK: "key"
   *  (rejected vendor key). Either: "capture" (no audio source) | "connect". */
  code: string;
  message: string;
}

/** Maps a `meeting://error` `code` to its toast translation key; unmapped codes fall back to "connect". */
const MEETING_ERROR_KEY_BY_CODE: Partial<Record<string, TranslationKey>> = {
  quota: "meeting.error.quota",
  auth: "meeting.error.auth",
  key: "meeting.error.key",
  capture: "meeting.error.capture",
};

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
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    return () => {};
  }
  return listen<MeetingErrorPayload>("meeting://error", (event) => {
    const { code } = event.payload;
    // Tear the (transcript-less) meeting down so the UI leaves "recording".
    useStore.getState().stopMeeting();
    invoke("stop_meeting").catch((error) =>
      log.warn("meeting: stop after backend error failed", { code, error: String(error) }),
    );
    const key: TranslationKey = MEETING_ERROR_KEY_BY_CODE[code] ?? "meeting.error.connect";
    toast.error(translate(useStore.getState().settings.language, key));
  });
}

/** Shape of the `meeting://transcription` payload: one STT leg's link state. */
type TranscriptionLinkPayload =
  /** A leg died or a handshake failed and a redial is scheduled. Fires once per
   *  attempt while offline; `attempt` is 1-based and consecutive. */
  | { source: string; state: "reconnecting"; attempt: number }
  /** A leg's handshake completed — including the meeting's very first one
   *  (leg 0), which the store ignores because nothing was reconnecting. */
  | { source: string; state: "live"; leg: number };

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
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    return () => {};
  }
  return listen<TranscriptionLinkPayload>("meeting://transcription", (event) => {
    const p = event.payload;
    const store = useStore.getState();
    if (p.state === "reconnecting") {
      log.info("meeting: transcription reconnecting", { source: p.source, attempt: p.attempt });
      store.reportTranscriptionLink(p.source, "reconnecting");
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

/** Shape of the `meeting://warning` payload (meeting keeps running). */
interface MeetingWarningPayload {
  /** "system-audio-silent" | "system-audio-unavailable" */
  code: string;
  message?: string;
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
  if (!("__TAURI_INTERNALS__" in globalThis)) {
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
