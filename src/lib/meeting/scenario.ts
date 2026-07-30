import { useStore } from "../store";
import type { ScenarioSet } from "../accounts/bundles";
import type { MeetingType } from "../types";

/**
 * Switch the meeting scenario, carrying its bound eval template along so the
 * coach feed's lens follows the board. Shared by the pre-flight subject panel
 * and the live rail's picker — the template hand-off is the easy half to
 * forget, and forgetting it leaves the coach evaluating against the previous
 * scenario's rubric.
 */
export function applyScenario(id: MeetingType, scenarios: ScenarioSet): void {
  const { settings, updateSettings } = useStore.getState();
  const next = scenarios.byId[id];
  const tpl = next?.evalTemplateId
    ? settings.evalTemplates.find((x) => x.id === next.evalTemplateId)
    : undefined;
  updateSettings({
    meetingType: id,
    ...(tpl ? { evaluations: tpl.evals.map((e) => ({ ...e })) } : {}),
  });
}
