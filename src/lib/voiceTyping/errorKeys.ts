import type { TranslationKey } from "../../i18n/messages";

/** Overlay message per error phase `message`: the host's own "no-key", or a
 *  backend failure code from `voicetyping://error` (see capture.rs). Anything
 *  unrecognized falls back to the generic error string. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  "no-key": "voiceTyping.noKey",
  "no-local-model": "voiceTyping.noLocalModel",
  quota: "voiceTyping.error.quota",
  auth: "voiceTyping.error.auth",
  key: "voiceTyping.error.key",
  // On-device failures (local_stt::failure_code).
  "local-missing": "voiceTyping.noLocalModel",
  "local-memory": "voiceTyping.error.localMemory",
  local: "voiceTyping.error.local",
};

/** The overlay's error text for an error phase `message`. */
export function overlayErrorKey(error: string | null): TranslationKey {
  return (error && ERROR_KEYS[error]) || "voiceTyping.error";
}
