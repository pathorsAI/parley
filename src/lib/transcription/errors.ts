import type { TranslationKey } from "../../i18n/messages";
import type { LocalFailureCode } from "./localModels";

/**
 * Every transcription error code → message, in one place. Two kinds of code
 * reach a surface:
 *
 * - a START BLOCK, decided by `prepareTranscription` / `uploadPickBlock` before
 *   anything starts ("no-key", "signin", "no-local-model", "no-upload");
 * - a SESSION FAILURE the backend reports once it has started — the
 *   `meeting://error` / `voicetyping://error` code ("quota" | "auth" | "key" |
 *   "capture" | "connect", see capture.rs `Failure::classify`; the on-device
 *   "local" | "local-memory" | "local-missing", see local_stt::failure_code),
 *   or for an upload the rejected `transcribe_file` message classified by
 *   `localFailureCode`.
 *
 * The same code reads differently per surface (a meeting toast, the
 * voice-typing overlay's one-line bubble, an upload's inline error), so each
 * lookup takes the surface. How a message is shown — toast, overlay, thrown
 * Error — stays with the surface.
 */
export type TranscriptionSurface = "meeting" | "voiceTyping" | "upload";

/** Why a session may not start (see prepare.ts). Kebab-case because these
 *  are also the codes the voice-typing overlay receives as is. */
export type TranscriptionBlock = "no-key" | "signin" | "no-local-model" | "no-upload";

/** Start-block text per surface, for the blocks each surface can get: only a
 *  meeting distinguishes "sign in" from "no key" (the other two say both in
 *  one line), and only an upload is refused for lacking batch support. */
const START_BLOCK_KEY = {
  meeting: {
    "no-key": "meeting.error.noSttKey",
    signin: "meeting.error.signin",
    "no-local-model": "localStt.error.notReady",
  },
  voiceTyping: {
    "no-key": "voiceTyping.noKey",
    "no-local-model": "voiceTyping.noLocalModel",
  },
  upload: {
    "no-key": "ingest.error.noSttKey",
    "no-local-model": "localStt.error.notReadyUpload",
    "no-upload": "ingest.error.providerNoUpload",
  },
} as const satisfies Record<TranscriptionSurface, Partial<Record<TranscriptionBlock, TranslationKey>>>;

export type SurfaceBlock<S extends TranscriptionSurface> = keyof (typeof START_BLOCK_KEY)[S];

/** The message for a start block on a surface. */
export function blockMessageKey<S extends TranscriptionSurface>(surface: S, block: SurfaceBlock<S>): TranslationKey {
  return (START_BLOCK_KEY[surface] as Record<SurfaceBlock<S>, TranslationKey>)[block];
}

/** The on-device codes, the same three on every surface. */
const LOCAL_FAILURE: Record<TranscriptionSurface, Record<LocalFailureCode, TranslationKey | null>> = {
  meeting: {
    "local-missing": "localStt.error.notReady",
    "local-memory": "localStt.error.memory",
    local: "localStt.error.failed",
  },
  voiceTyping: {
    "local-missing": "voiceTyping.noLocalModel",
    "local-memory": "voiceTyping.error.localMemory",
    local: "voiceTyping.error.local",
  },
  upload: {
    "local-missing": "localStt.error.notReadyUpload",
    "local-memory": "localStt.error.memory",
    // Unexplained on-device failure: the backend's own message is kept.
    local: null,
  },
};

/** Session-failure text per surface. The overlay's channel also carries the
 *  start blocks the host emits, so its table includes them. */
const SESSION_FAILURE_KEY: Record<TranscriptionSurface, Record<string, TranslationKey | null>> = {
  meeting: {
    quota: "meeting.error.quota",
    auth: "meeting.error.auth",
    key: "meeting.error.key",
    capture: "meeting.error.capture",
    ...LOCAL_FAILURE.meeting,
  },
  voiceTyping: {
    ...START_BLOCK_KEY.voiceTyping,
    quota: "voiceTyping.error.quota",
    auth: "voiceTyping.error.auth",
    key: "voiceTyping.error.key",
    ...LOCAL_FAILURE.voiceTyping,
  },
  upload: { ...LOCAL_FAILURE.upload },
};

/** What a code without its own message shows: the generic line for the
 *  surface, or (upload) nothing — keep the backend's message. */
const FALLBACK_KEY = {
  meeting: "meeting.error.connect",
  voiceTyping: "voiceTyping.error",
  upload: null,
} as const satisfies Record<TranscriptionSurface, TranslationKey | null>;

/** The message for a session failure code on a surface. A missing code (the
 *  overlay with no error) gets the surface's fallback, as an unknown one does. */
export function failureMessageKey(surface: "meeting" | "voiceTyping", code: string | null): TranslationKey;
export function failureMessageKey(surface: "upload", code: string): TranslationKey | null;
export function failureMessageKey(surface: TranscriptionSurface, code: string | null): TranslationKey | null {
  const table = SESSION_FAILURE_KEY[surface];
  // Own keys only: a code that happens to name an Object.prototype member
  // ("constructor", "toString", …) must not resolve to that function.
  const own = code !== null && Object.prototype.hasOwnProperty.call(table, code);
  return (own && table[code]) || FALLBACK_KEY[surface];
}

/** One of the backend's on-device failure codes. */
export function isLocalFailureCode(code: string): code is LocalFailureCode {
  return Object.prototype.hasOwnProperty.call(LOCAL_FAILURE.meeting, code);
}
