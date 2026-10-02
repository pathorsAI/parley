//! Esc cancels a dictation; Undo brings it back as a clipboard copy.
//!
//! The rules, kept pure (no clock, no Tauri) so every ordering is testable:
//!
//! - Esc cancels the dictation the overlay is showing, from its press until the
//!   host commits the text to the clipboard. The mic stops as on a release, and
//!   the recognizer still answers, so the text settles as usual — the host just
//!   never copies, pastes or records a cancelled dictation. It holds the text.
//! - The overlay offers Undo for {@link CANCEL_UNDO_MS}. Undo copies the text to
//!   the clipboard (never pastes: the caret may have moved since) and records
//!   it in the history. Undo before the text has settled waits for it.
//! - With no Undo, or a new press first, the text is dropped and never saved.
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

/** How long a cancelled dictation can be brought back. */
export const CANCEL_UNDO_MS = 5000;

/** What the host does with a cancelled dictation's settled text. */
export type HoldVerdict = "hold" | "recover" | "discard";

/** What an Undo click asks the host to do. */
export type UndoResult =
  | { kind: "none" }
  | { kind: "wait"; gen: number }
  | { kind: "now"; gen: number; text: string; polished: boolean };

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
    this.offer = { gen, settled: false, text: "", polished: false };
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
  settle(gen: number, text: string, polished: boolean): HoldVerdict {
    if (this.recovering.delete(gen)) return "recover";
    const o = this.offer;
    if (!o || o.gen !== gen) return "discard";
    o.text = text;
    o.polished = polished;
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
    return { kind: "now", gen: o.gen, text: o.text, polished: o.polished };
  }

  /** The Undo offer ran out. The generation whose text is now dropped, or
   *  null when nothing was on offer (an Undo already asked is not). */
  expire(): number | null {
    const o = this.offer;
    this.offer = null;
    return o ? o.gen : null;
  }

  /** A new press: withdraw the offer. True when an un-recovered dictation was
   *  dropped; one whose Undo was already asked is still recovered. */
  supersede(): boolean {
    const had = this.offer !== null;
    this.offer = null;
    return had;
  }
}
