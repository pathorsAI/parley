import { useStore } from "../store";
import type { ScenarioSet } from "../accounts/bundles";
import type { MeetingType } from "../types";

/**
 * Switch THIS meeting's scenario (R5: per-meeting state, never the global
 * default). Shared by the pre-flight subject panel, the live rail's picker and
 * the study screen.
 *
 * `carryEvalTemplate` decides whether the scenario's bound eval template also
 * becomes the active rubric. Picking a scenario for a meeting you are ABOUT to
 * have means the coach should evaluate against that scenario — forgetting the
 * hand-off leaves it judging by the previous scenario's rubric. Picking one
 * while REVIEWING a finished recording means neither: the active evaluations
 * belong to the next live meeting, and retagging an old call must not re-point
 * them. Hence opt-out rather than a second function — the live callers keep the
 * behavior they had, and the retrospective one says so at the call site.
 */
export function applyScenario(
  id: MeetingType,
  scenarios: ScenarioSet,
  opts?: { carryEvalTemplate?: boolean },
): void {
  const { settings, updateSettings, setMeetingType, setMeetingTypeHasBoard } = useStore.getState();
  const next = scenarios.byId[id];
  const tpl =
    (opts?.carryEvalTemplate ?? true) && next?.evalTemplateId
      ? settings.evalTemplates.find((x) => x.id === next.evalTemplateId)
      : undefined;
  setMeetingType(id);
  // The scheduler is synchronous and can't resolve the scenario set itself, so
  // every path that picks a type has to leave this flag behind. Unknown id →
  // true, which keeps the existing degrade-on-extraction behavior.
  setMeetingTypeHasBoard(next?.hasBoard ?? true);
  if (tpl) updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
}
