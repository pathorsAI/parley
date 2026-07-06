// Usage limits for the hosted "parley" provider — the service limits of the
// official/cloud build. They apply ONLY when the signed-in user picks the
// hosted "parley" provider; BYOK (bring-your-own-key) is uncapped because it
// never touches the Parley backend. This is the single source of truth for the
// client-side enforcement and the copy that explains it.
//
// The per-user monthly quotas (STT hours, LLM credits) are metered and enforced
// server-side — the constants here are the defaults the backend also uses, kept
// in sync for display fallbacks. The voice-typing cap is enforced on the client
// (with a Rust safety net) since it bounds a single live session, not a period.

/** Max length of a single hosted voice-typing dictation, in seconds. Past this
 *  the session auto-finalizes, delivering whatever was transcribed. Only
 *  applied for the "parley" STT provider. */
export const HOSTED_VOICE_TYPING_MAX_SECONDS = 600; // 10 minutes

/** Free monthly speech-to-text allowance, in seconds. Meeting transcription and
 *  voice typing SHARE this one pool (both stream through the same cloud relay).
 *  Authoritative value lives in the backend's `sttSecondsLimit`; mirrored here
 *  for display when the quota fetch hasn't landed yet. */
export const HOSTED_STT_MONTHLY_SECONDS = 20 * 60 * 60; // 20 hours

/** Default LLM credit allowance per user per month. A credit is a USD-denominated
 *  unit: LLM usage debits credits by the actual backend cost. Authoritative value
 *  lives in the backend's `llmCreditsLimit`; mirrored here for display fallback. */
export const HOSTED_LLM_MONTHLY_CREDITS = 10;
