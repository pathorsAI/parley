import { useStore } from "../store";
import type { Scenario } from "./bundles";

/**
 * THIS call's stage within a scenario: the user's per-call choice, or the
 * scenario's first stage.
 *
 * ONE implementation, because every surface that shows or uses a stage has to
 * agree: the live board renders it, the extraction pass runs against it, and
 * pre-flight lets you pick it — a picker showing "discovery" while the board
 * runs "negotiation" is a silent mismatch nobody would think to check.
 *
 * Pure, so React callers can derive it during render; {@link resolveScenarioStageId}
 * is the store-reading wrapper for imperative ones.
 */
export function stageFor(scenario: Scenario, meetingStage: string | null | undefined): string {
  if (meetingStage && scenario.order.includes(meetingStage)) return meetingStage;
  // A boardless KIND has no stages at all, so there is no first stage to fall
  // back to. Empty string rather than a `string`-typed undefined: callers look
  // the id up in `bundles`, which misses either way, but only one of the two
  // keeps the signature honest.
  return scenario.order[0] ?? "";
}

/** {@link stageFor} against the current store — for non-React callers (live
 *  intel extraction, board resolution). */
export function resolveScenarioStageId(scenario: Scenario): string {
  return stageFor(scenario, useStore.getState().meetingStage);
}
