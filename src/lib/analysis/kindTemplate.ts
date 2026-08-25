import { useStore } from "../store";
import { findActiveTemplate } from "../evaluations/presets";
import { EVAL_TEMPLATE_OF } from "./lens";
import { log } from "../log";
import type { MeetingKind } from "../types";

/**
 * Point the active evaluation set at the template a kind implies.
 *
 * The kind picks the LENS (output shape) directly, but the WATCHERS are still a
 * user-owned list. So an AUTO-DETECTED kind only swaps the set when the current
 * one is verbatim a built-in template: once someone has hand-edited their
 * watchers, `findActiveTemplate` returns null and we leave them alone — a guess
 * must never silently discard a deliberate list. `force` (the user picking a
 * kind themselves) skips that deference, because then it isn't a guess.
 *
 * Returns true when the set was swapped.
 */
export function applyKindTemplate(kind: MeetingKind, opts?: { force?: boolean }): boolean {
  const state = useStore.getState();
  const { evalTemplates, evaluations } = state.settings;
  const wanted = evalTemplates.find((t) => t.id === EVAL_TEMPLATE_OF[kind]);
  if (!wanted) return false;

  const active = findActiveTemplate(evalTemplates, evaluations);
  if (!active && !opts?.force) return false; // hand-edited — the user's list wins
  if (active?.id === wanted.id) return false; // already there

  state.updateSettings({ evaluations: wanted.evals.map((e) => ({ ...e })) });
  log.info("analysis: eval template followed meeting kind", { kind, template: wanted.id });
  return true;
}

/**
 * The user picking a kind by hand — from the report page, the live findings
 * panel, or the ingest wizard. Pins the kind (so the detection pass never
 * overwrites it) and switches the watchers to match.
 *
 * It does NOT re-run anything: regenerating is the analysis chip's job, and the
 * findings-stale banner already tells the user their outputs predate this
 * choice. Deciding for them would spend the deep lane on a mis-click.
 */
export function chooseMeetingKind(kind: MeetingKind): void {
  useStore.getState().setMeetingKind(kind);
  applyKindTemplate(kind, { force: true });
}
