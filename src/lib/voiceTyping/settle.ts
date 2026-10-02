//! When a released dictation is done: the host's settle policy, kept pure so
//! every timing rule is testable without a clock or a backend.
//!
//! The paste must wait for the recognizer's answer to the closing finalize —
//! Rust says so with `stt://closed`, which it always sends within a bounded
//! time (Soniox's `<fin>`, a closed socket, a failure, or DRAIN_READ_GRACE).
//! Everything else here is the safety net for a session whose close never
//! arrives (the backend aborted it, or a provider that never answers).
//!
//! What it must never do again is end a dictation on silence that began
//! BEFORE the release. The old rule measured quiet from the last text update,
//! so a short tap — no token back yet, because the relay takes about two
//! seconds to answer the first one — was "quiet" the moment the key came up
//! and pasted nothing, and a release right after the last word pasted the
//! interim text without the words the finalize was about to return.

/** Hard cap on the wait after the release. The log shows nothing delivered
 *  sooner than 3 s after the press, so a short tap's `<fin>` can land 2.5–3.5 s
 *  after the release; 6 s leaves about 2 s of margin for a slow connect and
 *  for the 1 s timer alignment of a hidden window. It also stays below
 *  RELEASE_TAIL + FLUSH_ABORT_GRACE (8.25 s), past which no close can come. */
export const CLOSE_WAIT_MAX_MS = 6000;
/** Silence never ends a still-open session sooner than this after the
 *  release. A healthy `<fin>` lands well before it. */
export const QUIET_FLOOR_MS = 1500;
/** How long the transcript must have been quiet before the quiet rule
 *  applies, counted from the last segment heard after the release. */
export const SETTLE_MS = 500;

/** Why a dictation was delivered when it was. */
export type SettleReason = "closed" | "failed" | "quiet" | "timeout";

export interface SettleInput {
  now: number;
  /** When the key came up (or the cap cut the session). */
  releasedAt: number;
  /** When `stt://closed` arrived for this session, 0 = not yet. */
  closedAt: number;
  /** The backend reported the session dead (`voicetyping://error`). */
  failed: boolean;
  /** When the last segment of this session arrived, 0 = none yet. */
  lastSegmentAt: number;
  /** The transcript still ends in a tentative (non-final) run. */
  tailPending: boolean;
}

export type SettleVerdict = { finalize: SettleReason } | { waitMs: number };

/**
 * Deliver now, or check again in `waitMs` (unless an event — a segment, the
 * close, an error — asks sooner). In order:
 *
 * 1. a failed session has no flush coming;
 * 2. a closed one has delivered every token it will;
 * 3. past the cap, give up waiting;
 * 4. not heard from since the release, or still tentative: keep waiting, up
 *    to the cap — pre-release quiet says nothing about the finalize;
 * 5. otherwise quiet once past the floor with SETTLE_MS of silence.
 */
export function settleVerdict(s: SettleInput): SettleVerdict {
  if (s.failed) return { finalize: "failed" };
  if (s.closedAt > 0) return { finalize: "closed" };
  const elapsed = s.now - s.releasedAt;
  const untilCap = CLOSE_WAIT_MAX_MS - elapsed;
  if (untilCap <= 0) return { finalize: "timeout" };
  const heard = s.lastSegmentAt >= s.releasedAt;
  if (!heard || s.tailPending) return { waitMs: Math.max(1, untilCap) };
  const untilQuiet = Math.max(QUIET_FLOOR_MS - elapsed, SETTLE_MS - (s.now - s.lastSegmentAt));
  if (untilQuiet <= 0) return { finalize: "quiet" };
  return { waitMs: Math.max(1, Math.min(untilCap, untilQuiet)) };
}
