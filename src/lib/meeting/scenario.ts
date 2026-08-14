import { useStore } from "../store";
import type { ScenarioSet } from "../accounts/bundles";
import type { MeetingType } from "../types";

/**
 * Switch THIS meeting's scenario (R5: per-meeting state, never the global
 * default), carrying its bound eval template along so the coach feed's lens
 * follows the board. Shared by the pre-flight subject panel and the live
 * rail's picker — the template hand-off is the easy half to forget, and
 * forgetting it leaves the coach evaluating against the previous scenario's
 * rubric.
 */
export function applyScenario(id: MeetingType, scenarios: ScenarioSet): void {
  const { settings, updateSettings, setMeetingType, setMeetingTypeHasBoard } = useStore.getState();
  const next = scenarios.byId[id];
  const tpl = next?.evalTemplateId
    ? settings.evalTemplates.find((x) => x.id === next.evalTemplateId)
    : undefined;
  setMeetingType(id);
  // The scheduler is synchronous and can't resolve the scenario set itself, so
  // every path that picks a type has to leave this flag behind. Unknown id →
  // true, which keeps the existing degrade-on-extraction behavior.
  setMeetingTypeHasBoard(next?.hasBoard ?? true);
  if (tpl) updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
}
