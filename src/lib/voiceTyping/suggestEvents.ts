//! The main window ⇄ overlay conversation for the "add this correction to the
//! dictionary?" bubble.
//!
//! The split is deliberate: the MAIN window owns every decision (diffing the
//! correction, writing the dictionary, the ignore bookkeeping, the timers and
//! the temporary ⌥↩ shortcut) and the OVERLAY only renders what it's told and
//! reports the click. The overlay is a non-activating panel that comes and goes
//! — state parked there would die with it.

/** main → overlay: show the question bubble for this correction. */
export const SUGGEST_EVENT = "voicetyping://suggest";
/** main → overlay: move the bubble to its confirmed state, or take it away. */
export const SUGGEST_STATE_EVENT = "voicetyping://suggest-state";
/** overlay → main: the user pressed one of the bubble's buttons. */
export const SUGGEST_ACTION_EVENT = "voicetyping://suggest-action";
/** Rust → main: the observed field settled on a new value. */
export const CORRECTION_CANDIDATE_EVENT = "voicetyping://correction-candidate";

export interface SuggestPayload {
  from: string;
  to: string;
}

export interface SuggestStatePayload {
  /** "added" = the confirmed state (with undo); "hidden" = drop the bubble. */
  state: "added" | "hidden";
}

export interface SuggestActionPayload {
  action: "add" | "ignore" | "undo";
}

export interface CorrectionCandidatePayload {
  /** The field's value right after Parley pasted into it. */
  baseline: string;
  /** Its value once the user stopped editing. */
  current: string;
  /** What Parley pasted — the diff has to land inside this. */
  insertedText: string;
}
