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
//! BEFORE the finalize could go out. The old rule measured quiet from the last
//! text update, so a short tap — no token back yet, because the relay takes
//! about two seconds to accept the connection — was "quiet" the moment the key
//! came up and pasted nothing, and a release right after the last word pasted
//! the interim text without the words the finalize was about to return. Every
//! clock here therefore starts at the later of the release and the connect,
//! and a provider that answers the finalize is never cut short on silence.

/** No socket yet at the release: nothing can come back before it connects
 *  and the audio buffered since the press goes out. The hosted relay usually
 *  takes about two seconds to accept a connection and has been seen at six and
 *  a half, so a short tap is routinely released first. Rust fails a connect
 *  that takes longer than CONNECT_TIMEOUT (15 s, from the press) and that
 *  failure settles at once; this is only the backstop for an answer that never
 *  arrives at all. */
export const CONNECT_WAIT_MAX_MS = 18000;
/** Hard cap on the wait for the close, counted from the later of the release
 *  and the connect — the moment the finalize can actually go out. On the
 *  hosted relay the `<fin>` comes back 0.5–3 s after that; 6 s leaves margin
 *  for a slow recognizer and the 1 s timer alignment of a hidden window. Rust
 *  always ends the session DRAIN_READ_GRACE (7 s) after the finalize at the
 *  latest, so this only fires for a close that was lost. */
export const CLOSE_WAIT_MAX_MS = 6000;
/** Silence never ends a still-open session sooner than this after the
 *  finalize could go out. Only for providers that do not answer the finalize
 *  (`acksFinalize` false); a healthy close lands well before it. */
export const QUIET_FLOOR_MS = 1500;
/** How long the transcript must have been quiet before the quiet rule
 *  applies, counted from the last segment heard after the finalize. */
export const SETTLE_MS = 500;

/** Why a dictation was delivered when it was. */
export type SettleReason = "closed" | "failed" | "quiet" | "timeout";

export interface SettleInput {
  now: number;
  /** When the key came up (or the cap cut the session). */
  releasedAt: number;
  /** When the session's socket opened (`stt://connected`), 0 = not yet. */
  connectedAt: number;
  /** The provider answers the closing finalize with an explicit end
   *  (Soniox's `<fin>`): its close is the only end worth waiting for. */
  acksFinalize: boolean;
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
 * connect, the close, an error — asks sooner). In order:
 *
 * 1. a failed session has no flush coming;
 * 2. a closed one has delivered every token it will;
 * 3. not connected yet: keep waiting (up to CONNECT_WAIT_MAX_MS from the
 *    release) — no answer can exist before the connect, so neither silence
 *    nor the close cap means anything yet;
 * 4. past the close cap, counted from when the finalize could go out, give up;
 * 5. a provider that answers the finalize: wait for that answer;
 * 6. not heard from since the finalize could go out, or still tentative: keep
 *    waiting, up to the cap — earlier quiet says nothing about the finalize;
 * 7. otherwise quiet once past the floor with SETTLE_MS of silence.
 */
export function settleVerdict(s: SettleInput): SettleVerdict {
  if (s.failed) return { finalize: "failed" };
  if (s.closedAt > 0) return { finalize: "closed" };
  if (s.connectedAt === 0) {
    const untilGiveUp = CONNECT_WAIT_MAX_MS - (s.now - s.releasedAt);
    return untilGiveUp <= 0 ? { finalize: "timeout" } : { waitMs: untilGiveUp };
  }
  const finalizeAt = Math.max(s.releasedAt, s.connectedAt);
  const elapsed = s.now - finalizeAt;
  const untilCap = CLOSE_WAIT_MAX_MS - elapsed;
  if (untilCap <= 0) return { finalize: "timeout" };
  const heard = s.lastSegmentAt >= finalizeAt;
  if (s.acksFinalize || !heard || s.tailPending) return { waitMs: Math.max(1, untilCap) };
  const untilQuiet = Math.max(QUIET_FLOOR_MS - elapsed, SETTLE_MS - (s.now - s.lastSegmentAt));
  if (untilQuiet <= 0) return { finalize: "quiet" };
  return { waitMs: Math.max(1, Math.min(untilCap, untilQuiet)) };
}
