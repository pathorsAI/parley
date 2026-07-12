import type { Claim } from "./types";
import type { SlotDef, StageBundle } from "./bundles";

/**
 * Gap-board slot state (design docs/design/stage-bundles.md §4.1, #146): pure
 * functions only — no store, no AI. Thresholds are constants for now and get
 * calibrated against a real card base during P1 (doc open question 1).
 */

/** Fresh cards needed for "solid" when the slot doesn't override `solidAt`. */
export const SLOT_SOLID_AT = 2;
/** A card older than this (by lastSupportedAt) no longer counts as fresh. */
export const SLOT_STALE_DAYS = 30;

const DAY_MS = 86_400_000;

/** 空（dashed）／薄（amber）／實（green）— visual only, no scores (S12). */
export type SlotState = "empty" | "thin" | "solid";

/** Does a claim match the slot's coarse query? (Fallback for untagged cards, S3.) */
export function slotQueryMatches(claim: Claim, slot: SlotDef): boolean {
  const q = slot.query;
  if (!q.categories.includes(claim.category)) return false;
  if (q.side && claim.side !== q.side) return false;
  if (q.layer && claim.layer !== q.layer) return false;
  return true;
}

/**
 * Active claims attached to a slot. Tagged cards (`slotIds` present) are
 * authoritative — including `[]` = classified-none; untagged cards fall back
 * to the coarse query so old/manual cards pre-attach before backfill runs.
 */
export function claimsForSlot(claims: Claim[], slot: SlotDef): Claim[] {
  return claims.filter(
    (c) =>
      c.status === "active" &&
      (c.slotIds ? c.slotIds.includes(slot.id) : slotQueryMatches(c, slot))
  );
}

/**
 * 空/薄/實 for one slot (doc §3): solid = one fresh CONFIRMED card, or
 * `solidAt` (default 2) fresh cards of any confidence; a slot whose cards are
 * all stale (>30 days) stays thin no matter their confidence.
 */
export function slotState(attached: Claim[], slot: SlotDef, nowMs: number): SlotState {
  if (attached.length === 0) return "empty";
  const staleMs = SLOT_STALE_DAYS * DAY_MS;
  const fresh = attached.filter((c) => nowMs - c.lastSupportedAt <= staleMs);
  if (fresh.some((c) => c.confidence === "confirmed")) return "solid";
  if (fresh.length >= (slot.solidAt ?? SLOT_SOLID_AT)) return "solid";
  return "thin";
}

/** Per-slot view of a whole board — the shape #147 renders from. */
export function boardStates(
  claims: Claim[],
  bundle: StageBundle,
  nowMs: number
): { slot: SlotDef; claims: Claim[]; state: SlotState }[] {
  return bundle.slots.map((slot) => {
    const attached = claimsForSlot(claims, slot);
    return { slot, claims: attached, state: slotState(attached, slot, nowMs) };
  });
}
