import { useStore } from "../store";
import { useAccounts } from "./store";
import type { Scenario } from "./bundles";

/**
 * THIS call's stage within a scenario, resolved imperatively for non-React
 * callers (live intel extraction / board resolution). Precedence: the user's
 * per-call choice → (sales only) the linked thread's stage → the scenario's
 * first stage. ScenarioBoard derives the same thing reactively — keep the two
 * in step.
 */
export function resolveScenarioStageId(scenario: Scenario): string {
  const s = useStore.getState();
  if (s.meetingStage && scenario.order.includes(s.meetingStage)) return s.meetingStage;
  if (scenario.id === "sales") {
    const thread = useAccounts.getState().threads.find((t) => t.id === s.meetingThreadId);
    const threadStage = thread?.kind === "sales" ? thread.stage : undefined;
    if (threadStage && scenario.order.includes(threadStage)) return threadStage;
  }
  return scenario.order[0];
}
