import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { toTraditional } from "./zhConvert";
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

/** True when running inside the Tauri shell (vs a plain browser dev session). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
