//! Esc cancels a dictation; Undo brings it back as a clipboard copy.
//!
//! The rules, kept pure (no clock, no Tauri) so every ordering is testable:
//!
//! - Esc cancels the dictation the overlay is showing, from its press until the
//!   host sends the text to the field. The mic stops as on a release, and the
//!   recognizer still answers, so the text settles as usual — the host just
//!   never inserts or records a cancelled dictation. It holds the text.
//! - The overlay offers Undo for a window that follows the dictation's own
//!   length ({@link undoWindowMs}). Undo copies the text to the clipboard
//!   (never pastes: the caret may have moved since) and records it in the
//!   history. Undo before the text has settled waits for it.
//! - Esc is a global shortcut while it is armed, so no other app sees it. A
//!   long dictation gives the bare one back and keeps only the trigger's own
//!   modifier+Esc (see {@link ESC_BARE_CLAIM_MS}).
//! - With no Undo, or a new press first, the text is delivered nowhere — but
//!   it is still written to the dictation history, flagged `cancelled`, so a
//!   long dictation lost to a stray Esc can be read back (#640).
//!
//! The host (host.ts) owns the timer, the overlay and the session state; this
//! ledger only answers "what happens to this generation's text".

/** Rust → main window: Esc was pressed while a dictation was cancellable. */
export const CANCEL_EVENT = "voicetyping://cancel";

export interface CancelPayload {
  /** The Windows keyboard hook caught this Esc under the held push-to-talk
   *  key and swallowed it, which also silences that key's release — the host
   *  must settle the release's bookkeeping itself. False (or absent) for the
   *  Esc global shortcut. */
  fromTrigger?: boolean;
}

/** Overlay → main window: the Undo on the "cancelled" pill was clicked. */
export const CANCEL_ACTION_EVENT = "voicetyping://cancel-action";

export interface CancelActionPayload {
  action: "undo";
}

/** The floor of the Undo window: enough to take back a sentence. */
export const CANCEL_UNDO_MS = 5000;

/** Its ceiling, however long the dictation ran. */
export const CANCEL_UNDO_MAX_MS = 30_000;

/**
 * How long Undo stays on offer for a dictation that recorded `speechMs`: half
 * the time spent talking, inside
 * [{@link CANCEL_UNDO_MS}, {@link CANCEL_UNDO_MAX_MS}].
 *
 * Five seconds is plenty for taking back a sentence and nowhere near enough to
 * notice that a stray Esc just ended seven minutes of dictation (#640). The
 * text reaches the history either way, so this only decides how long the
 * one-click route back into the field stays open.
 */
export function undoWindowMs(speechMs: number): number {
  if (!Number.isFinite(speechMs) || speechMs <= 0) return CANCEL_UNDO_MS;
  return Math.min(CANCEL_UNDO_MAX_MS, Math.max(CANCEL_UNDO_MS, Math.round(speechMs / 2)));
}

/**
 * How long a dictation keeps the BARE Esc claimed globally.
 *
 * An armed Esc is a global shortcut: no other app sees it. That is the right
 * trade for a dictation a few seconds old, where Esc can only mean "never mind
 * this" — but not for a long one, where an Esc meant for the app in front is
 * both swallowed and destructive (#640). Past this the host hands the bare Esc
 * back and keeps the trigger's own modifier+Esc, which no stray press hits. A
 * trigger that leaves no such chord (fn, Windows' modifier triggers, the tray)
 * keeps the bare Esc: otherwise a long dictation would have no cancel key.
 */
export const ESC_BARE_CLAIM_MS = 60_000;

/** What the host does with a cancelled dictation's settled text. */
export type HoldVerdict = "hold" | "recover" | "discard";

/** A cancelled dictation the host must drop: no Undo asked for it, so nothing
 *  is delivered. `text` is what it settled on — empty while it is still
 *  settling, in which case the host records it off {@link CancelLedger.settle}'s
 *  "discard" verdict instead. */
export interface Dropped {
  gen: number;
  text: string;
}

/** What an Undo click asks the host to do. */
export type UndoResult =
  | { kind: "none" }
  | { kind: "wait"; gen: number }
  | { kind: "now"; gen: number; text: string; polished: boolean; gateText: string };

/** How many cancelled generations are remembered. A delivery is at most a few
 *  dictations behind the newest one, so this only bounds memory. */
const REMEMBERED = 16;

/** The cancelled dictation whose Undo the overlay is offering. */
interface Offer {
  gen: number;
  settled: boolean;
  text: string;
  /** `text` already went through the polish pass (whatever its outcome). */
  polished: boolean;
  /** What polish's length gate measures for `text` while `polished` is
   *  false: the transcript before its pause-made marks were softened. */
  gateText: string;
}

/**
 * Which dictations were cancelled, and what happens to their text.
 *
 * `cancelled` outlives the Undo offer on purpose: a delivery still settling or
 * polishing for a cancelled dictation when the offer closes (or a new press
 * replaces it) must still never paste. The overlay shows one offer at a time,
 * so a second cancel replaces the first offer — but an Undo already asked for
 * is no longer an offer, it is a promise, and it survives that.
 */
export class CancelLedger {
  private readonly cancelled = new Set<number>();
  private offer: Offer | null = null;
  /** Undo was asked before these settled: recover each the moment it does. */
  private readonly recovering = new Set<number>();

  /** Esc on generation `gen`. False when it was already cancelled. */
  cancel(gen: number): boolean {
    if (this.cancelled.has(gen)) return false;
    this.cancelled.add(gen);
    if (this.cancelled.size > REMEMBERED) this.cancelled.delete(Math.min(...this.cancelled));
    this.offer = { gen, settled: false, text: "", polished: false, gateText: "" };
    return true;
  }

  isCancelled(gen: number): boolean {
    return this.cancelled.has(gen);
  }

  /** The start of `gen` failed: there is no dictation to cancel or hold. */
  forget(gen: number): void {
    this.cancelled.delete(gen);
    this.recovering.delete(gen);
    if (this.offer?.gen === gen) this.offer = null;
  }

  /**
   * The cancelled `gen` settled on `text`. "recover" when Undo already asked
   * for it (deliver it to the clipboard now), "hold" while its offer is open,
   * "discard" when it is no longer on offer.
   */
  settle(gen: number, text: string, polished: boolean, gateText = text): HoldVerdict {
    if (this.recovering.delete(gen)) return "recover";
    const o = this.offer;
    if (!o || o.gen !== gen) return "discard";
    o.text = text;
    o.polished = polished;
    o.gateText = gateText;
    o.settled = true;
    return "hold";
  }

  /** Undo was clicked: hand the text back now, or once it settles. */
  undo(): UndoResult {
    const o = this.offer;
    if (!o) return { kind: "none" };
    this.offer = null;
    if (!o.settled) {
      this.recovering.add(o.gen);
      return { kind: "wait", gen: o.gen };
    }
    return { kind: "now", gen: o.gen, text: o.text, polished: o.polished, gateText: o.gateText };
  }

  /** The Undo offer ran out: the dictation that is now dropped, or null when
   *  nothing was on offer (an Undo already asked is not). */
  expire(): Dropped | null {
    return this.drop();
  }

  /** A new press: withdraw the offer. The dropped dictation, or null when its
   *  Undo was already asked — that one is still recovered. */
  supersede(): Dropped | null {
    return this.drop();
  }

  /** Withdraw the offer and say what it was holding. The text is empty when it
   *  had not settled yet: the host hears about that one through `settle`. */
  private drop(): Dropped | null {
    const o = this.offer;
    this.offer = null;
    return o ? { gen: o.gen, text: o.settled ? o.text : "" } : null;
  }
}
