import { useStore } from "../store";
import { useAccounts } from "./store";
import type { Scenario } from "./bundles";
import type { Thread } from "./types";

/**
 * THIS call's stage within a scenario. Precedence: the user's per-call choice →
 * (sales only) the linked thread's stage → the scenario's first stage.
 *
 * ONE implementation, because every surface that shows or uses a stage has to
 * agree: the live board renders it, the extraction pass runs against it, and
 * pre-flight lets you pick it — a picker showing "discovery" while the board
 * runs "negotiation" is a silent mismatch nobody would think to check.
 *
 * Pure, so React callers can derive it during render; {@link resolveScenarioStageId}
 * is the store-reading wrapper for imperative ones.
 */
export function stageFor(
  scenario: Scenario,
  meetingStage: string | null | undefined,
  thread: Pick<Thread, "kind" | "stage"> | null | undefined
): string {
  if (meetingStage && scenario.order.includes(meetingStage)) return meetingStage;
  if (scenario.id === "sales" && thread?.kind === "sales") {
    const threadStage = thread.stage;
    if (threadStage && scenario.order.includes(threadStage)) return threadStage;
  }
  // A boardless KIND has no stages at all, so there is no first stage to fall
  // back to. Empty string rather than a `string`-typed undefined: callers look
  // the id up in `bundles`, which misses either way, but only one of the two
  // keeps the signature honest.
  return scenario.order[0] ?? "";
}

/** {@link stageFor} against the current store — for non-React callers (live
 *  intel extraction, board resolution). */
export function resolveScenarioStageId(scenario: Scenario): string {
  const s = useStore.getState();
  const thread = useAccounts.getState().threads.find((t) => t.id === s.meetingThreadId);
  return stageFor(scenario, s.meetingStage, thread);
}
