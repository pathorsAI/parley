import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import type { SessionEvent } from "../voiceTyping/transcript";
import type { LocalSttProgress, LocalSttSlowPayload } from "../transcription/localModels";

/**
 * The Tauri event contract: the names the backend emits, their payloads, and
 * the one way to subscribe. Nothing outside src/lib/ipc imports
 * `@tauri-apps/api/event` (enforced by ipc/boundary.test.ts).
 *
 * Events the frontend windows send each other (settings sync, the overlay's
 * buttons, finding-solution, …) keep their name constants next to the code
 * that owns them; they go through {@link listenEvent} / {@link emitEvent} too,
 * with the payload type given at the call site.
 */
export type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";

// ── Names the backend emits ─────────────────────────────────────────────────

/** A transcript segment, partial or final (transcription/common.rs). Shared by
 *  meetings and voice typing; `source` "voice-typing" belongs to the overlay. */
export const TRANSCRIPT_SEGMENT_EVENT = "transcript://segment";
/** Live input level, ~10×/s. */
export const AUDIO_LEVEL_EVENT = "audio://level";
/** Live delivery coaching on the "me" mic. */
export const AUDIO_PROSODY_EVENT = "audio://prosody";
/** The meeting capture started or stopped. */
export const MEETING_STATUS_EVENT = "meeting://status";
/** A transcription session failed for good (see capture.rs `Failure`). */
export const MEETING_ERROR_EVENT = "meeting://error";
/** A non-fatal meeting warning (system audio missing). */
export const MEETING_WARNING_EVENT = "meeting://warning";
/** One STT leg's link state (reconnecting / live again). */
export const MEETING_TRANSCRIPTION_EVENT = "meeting://transcription";
/** The computer came back from sleep: `{ sleptMs }` (sleep_watch.rs). */
export const SYSTEM_WAKE_EVENT = "system://wake";
/** Speaker-diarization progress (model download, decoding, clustering). */
export const DIARIZE_PROGRESS_EVENT = "diarize://progress";
/** An STT session's socket opened. */
export const STT_CONNECTED_EVENT = "stt://connected";
/** An STT session closed after its final answer. */
export const STT_CLOSED_EVENT = "stt://closed";
/** Onboarding's microphone check failed (mic_check.rs), payload like `meeting://error`. */
export const MIC_CHECK_ERROR_EVENT = "miccheck://error";
/** Seconds of audio a session sent to a provider, for the usage log. */
export const STT_USAGE_EVENT = "usage://stt";
/** The push-to-talk key went down / up. */
export const VOICE_TYPING_PTT_EVENT = "voicetyping://ptt";
/** A dictation's STT session failed. */
export const VOICE_TYPING_ERROR_EVENT = "voicetyping://error";
/** The dictation lifecycle shown by the overlay (`start` from Rust; the other
 *  phases from the host window). */
export const VOICE_TYPING_SESSION_EVENT = "voicetyping://session";
/** The OAuth loopback finished. */
export const AUTH_CALLBACK_EVENT = "auth://callback";
/** An MCP client queued session commands. */
export const SESSION_COMMANDS_EVENT = "session://commands";
/** The app menu cleared the analysis cache. */
export const CACHE_CLEAR_ANALYSIS_EVENT = "cache://clear-analysis";
/** The app menu cleared the speaker-name cache. */
export const CACHE_CLEAR_SPEAKERS_EVENT = "cache://clear-speakers";
/** On-device model download progress (local_stt.rs `PROGRESS_EVENT`). */
export const LOCAL_STT_PROGRESS_EVENT = "local-stt://progress";
/** Emitted (at most once per session) when on-device decoding falls behind
 *  real time (local_stt.rs `SLOW_EVENT`). */
export const LOCAL_STT_SLOW_EVENT = "local-stt://slow";

// ── Their payloads (as serialized: snake_case unless the Rust side renames) ─

export interface TranscriptSegmentPayload {
  id: string;
  /** "me" | "them" for a meeting, "voice-typing" for a dictation, "mic-check"
   *  for onboarding's microphone check. */
  source: string;
  /** Diarized speaker number within this source (0 = unknown / single speaker). */
  speaker: number;
  text: string;
  is_final: boolean;
  start_ms: number;
  end_ms: number;
  /** The backend session that produced it; null for a meeting's segments. */
  session: number | null;
}

export interface AudioLevelPayload {
  source: string;
  level: number;
  session: number | null;
}

export interface ProsodyPayload {
  source: string;
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

export interface MeetingErrorPayload {
  source: string;
  /** Hosted: "quota" (402) | "auth" (401 expired session). BYOK: "key"
   *  (rejected vendor key). On-device: "local-missing" | "local-memory" |
   *  "local" (see lib/transcription/errors.ts). Any: "capture" (no audio
   *  source) | "connect". */
  code: string;
  message: string;
}

export interface MeetingWarningPayload {
  /** "system-audio-silent" | "system-audio-unavailable" */
  code: string;
  message?: string;
}

export type TranscriptionLinkPayload =
  /** A leg died or a handshake failed and a redial is scheduled. Fires once per
   *  attempt while offline; `attempt` is 1-based and consecutive. */
  | { source: string; state: "reconnecting"; attempt: number }
  /** A leg's handshake completed — including the meeting's very first one
   *  (leg 0), which the store ignores because nothing was reconnecting. */
  | { source: string; state: "live"; leg: number }
  /** No audio is being captured (and the meeting is not paused): the backend
   *  closed this source's session instead of redialling one that would idle
   *  out, and dials again — reporting "live" — once audio arrives. */
  | { source: string; state: "no_audio" };

export interface DiarizeProgressPayload {
  stage: string;
  /** Items done (segments embedded, or bytes downloaded). */
  received: number;
  /** Total (0 ⇒ indeterminate stage). */
  total: number;
}

export interface SttConnectedPayload {
  source: string;
  session: number | null;
  /** The session answers a finalize with its final tokens. */
  acksFinalize?: boolean;
}

export interface SttClosedPayload {
  source: string;
  session: number | null;
}

export interface SttUsagePayload {
  provider: string;
  source: string;
  seconds: number;
}

export interface VoiceTypingErrorPayload {
  code: string;
  session: number | null;
}

export interface PttPayload {
  down: boolean;
}

export interface SystemWakePayload {
  /** How long the machine was asleep (ms), as the heartbeat measured it. */
  sleptMs: number;
}

export interface AuthCallbackPayload {
  token?: string;
  error?: string;
}

/** Every backend event's payload, by name. */
export interface BackendEventPayloads {
  [TRANSCRIPT_SEGMENT_EVENT]: TranscriptSegmentPayload;
  [AUDIO_LEVEL_EVENT]: AudioLevelPayload;
  [AUDIO_PROSODY_EVENT]: ProsodyPayload;
  /** "recording" | "idle" … — only the change itself is ever used. */
  [MEETING_STATUS_EVENT]: string;
  [MEETING_ERROR_EVENT]: MeetingErrorPayload;
  [MEETING_WARNING_EVENT]: MeetingWarningPayload;
  [MEETING_TRANSCRIPTION_EVENT]: TranscriptionLinkPayload;
  [DIARIZE_PROGRESS_EVENT]: DiarizeProgressPayload;
  [STT_CONNECTED_EVENT]: SttConnectedPayload;
  [STT_CLOSED_EVENT]: SttClosedPayload;
  [MIC_CHECK_ERROR_EVENT]: MeetingErrorPayload;
  [STT_USAGE_EVENT]: SttUsagePayload;
  [VOICE_TYPING_PTT_EVENT]: PttPayload;
  [VOICE_TYPING_ERROR_EVENT]: VoiceTypingErrorPayload;
  [VOICE_TYPING_SESSION_EVENT]: SessionEvent;
  [AUTH_CALLBACK_EVENT]: AuthCallbackPayload;
  [SYSTEM_WAKE_EVENT]: SystemWakePayload;
  [SESSION_COMMANDS_EVENT]: unknown;
  [CACHE_CLEAR_ANALYSIS_EVENT]: unknown;
  [CACHE_CLEAR_SPEAKERS_EVENT]: unknown;
  [LOCAL_STT_PROGRESS_EVENT]: LocalSttProgress;
  [LOCAL_STT_SLOW_EVENT]: LocalSttSlowPayload;
}

export type BackendEvent = keyof BackendEventPayloads;

// ── Subscribing ─────────────────────────────────────────────────────────────

/**
 * Subscribe to an event. A backend event's payload type comes from
 * {@link BackendEventPayloads}; any other event names its payload type at the
 * call site. Exactly Tauri's `listen` — it rejects outside the Tauri shell;
 * see {@link listenIfTauri} for the guarded form.
 */
export function listenEvent<E extends BackendEvent>(
  name: E,
  handler: EventCallback<BackendEventPayloads[E]>,
): Promise<UnlistenFn>;
export function listenEvent<T>(name: string, handler: EventCallback<T>): Promise<UnlistenFn>;
export function listenEvent(name: string, handler: EventCallback<unknown>): Promise<UnlistenFn> {
  return listen(name, handler);
}

const noop: UnlistenFn = () => {};

/**
 * {@link listenEvent}, but a no-op outside the Tauri shell (plain `vite` in a
 * browser, the unit suite): resolves to an unlisten that does nothing.
 */
export function listenIfTauri<E extends BackendEvent>(
  name: E,
  handler: EventCallback<BackendEventPayloads[E]>,
): Promise<UnlistenFn>;
export function listenIfTauri<T>(name: string, handler: EventCallback<T>): Promise<UnlistenFn>;
export function listenIfTauri(name: string, handler: EventCallback<unknown>): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(noop);
  return listen(name, handler);
}

/** Send an event to every window: Tauri's `emit`, as is. */
export { emit as emitEvent } from "@tauri-apps/api/event";

/**
 * The listeners a React effect (or any setup with a teardown) starts, released
 * together. `listen()` resolves its unlisten on a LATER tick, so a teardown
 * that runs first (StrictMode's dev double mount, HMR, a fast unmount) would
 * otherwise leave the late subscription attached — a duplicate handler for the
 * life of the window. A listener that resolves after `dispose()` is unlistened
 * the moment it arrives; one that fails to register goes to `onError`.
 */
export interface ListenerScope {
  track(subscription: Promise<UnlistenFn>): void;
  dispose(): void;
}

export function createListenerScope(onError: (error: unknown) => void): ListenerScope {
  let active = true;
  const live: UnlistenFn[] = [];
  return {
    track(subscription) {
      subscription
        .then((unlisten) => {
          if (active) live.push(unlisten);
          else unlisten();
        })
        .catch(onError);
    },
    dispose() {
      active = false;
      live.forEach((unlisten) => unlisten());
      live.length = 0;
    },
  };
}
