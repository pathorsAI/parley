import { useStore } from "../store";
import { findActiveTemplate } from "../evaluations/presets";
import { EVAL_TEMPLATE_OF } from "./lens";
import { log } from "../log";
import type { MeetingKind, Settings } from "../types";

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
  const wanted = templateSwapFor(kind, state.settings, opts);
  if (!wanted) return false;

  state.updateSettings({ evaluations: wanted.evals.map((e) => ({ ...e })) });
  log.info("analysis: eval template followed meeting kind", { kind, template: wanted.id });
  return true;
}

/** The template {@link applyKindTemplate} would swap in, or null when it would
 *  leave the set alone. */
function templateSwapFor(
  kind: MeetingKind,
  settings: Pick<Settings, "evalTemplates" | "evaluations">,
  opts?: { force?: boolean },
) {
  const { evalTemplates, evaluations } = settings;
  const wanted = evalTemplates.find((t) => t.id === EVAL_TEMPLATE_OF[kind]);
  if (!wanted) return null;

  const active = findActiveTemplate(evalTemplates, evaluations);
  if (!active && !opts?.force) return null; // hand-edited — the user's list wins
  if (active?.id === wanted.id) return null; // already there
  return wanted;
}

/**
 * The evaluation set an auto-detected kind implies, WITHOUT applying it — for a
 * pass that outlived its recording being on screen (the user opened another
 * one). Swapping the global watchers then would act on whatever is loaded now,
 * but the pass still has to analyze with the set this recording would have had.
 */
export function evalsImpliedBy(
  kind: MeetingKind | null,
  settings: Pick<Settings, "evalTemplates" | "evaluations">,
): Settings["evaluations"] {
  const wanted = kind ? templateSwapFor(kind, settings) : null;
  return wanted ? wanted.evals.map((e) => ({ ...e })) : settings.evaluations;
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
