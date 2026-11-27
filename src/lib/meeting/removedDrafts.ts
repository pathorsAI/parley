// The drafts that left the list. Nothing is taken off the saved drafts without
// landing here first, so "where did my draft go" always has an answer — it was
// recorded from, deleted, or removed on another device — and a way back
// (store/prep.ts restoreDraft). Pure.

import type { MeetingDraft } from "../store/prep";

/** Why a draft left the list. */
export type DraftRemoval =
  /** Taken to record: its preparation went into that meeting. */
  | "recorded"
  /** Deleted here, by the user or an MCP client. */
  | "deleted"
  /** Removed by the cloud sync: recorded or deleted on another device. */
  | "elsewhere";

export const DRAFT_REMOVALS: readonly DraftRemoval[] = ["recorded", "deleted", "elsewhere"];

/** A draft that left the list, kept so it can be found and brought back. */
export interface RemovedDraft {
  draft: MeetingDraft;
  removedAt: number;
  reason: DraftRemoval;
}

/** How many removed drafts are kept, newest first. */
export const REMOVED_DRAFTS_KEPT = 20;

/** `removed` with `draft` filed at the front (replacing an older entry of the
 *  same id), cut to REMOVED_DRAFTS_KEPT. */
export function withRemovedDraft(
  removed: readonly RemovedDraft[],
  draft: MeetingDraft,
  reason: DraftRemoval,
  now: number,
): RemovedDraft[] {
  return [{ draft, removedAt: now, reason }, ...removed.filter((r) => r.draft.id !== draft.id)].slice(
    0,
    REMOVED_DRAFTS_KEPT,
  );
}
