import type { EvalDef, EvalTemplate, Evaluation } from "../types";
import type { TranslationKey } from "../../i18n/messages";
import { STUDY } from "../ai/studyPrompt";

/**
 * Built-in evaluation definitions and the template library that ship with
 * Parley — one template per {@link MeetingKind}: internal working meetings,
 * sales calls, price negotiations, and talks with a competitor.
 *
 * These are the WATCHER lists only. What the analysis OUTPUT looks like is the
 * other axis (analysis/lens.ts), which the same kind selects; keeping the two
 * separate is what lets 議價 and 對手談判 share an output shape while watching
 * for completely different things.
 *
 * The data — which evals exist, each one's `prompt`, and which evals each
 * template carries, in order — lives in shared/prompts/study.json (`evals`,
 * `templates`, `coreEvals`), shared with Android. The `prompt` is the
 * instruction handed to the LLM and stays in English on purpose — it's model
 * input, not UI. Display strings (names/descriptions) are looked up through
 * i18n (`tpl.eval.<id>.name|desc`, `tpl.evalSet.<id>.name`) so built-in
 * templates follow the UI language; tests/studyPrompts.test.ts keeps the names
 * in the JSON (which Android shows) equal to the i18n ones.
 */

/** A translate function bound to the current language: `(key) => string`. */
type T = (key: TranslationKey) => string;

const EVAL_PROMPTS: Record<string, { prompt: string }> = STUDY.evals;
const TEMPLATE_EVALS: Record<string, string[]> = STUDY.templates;

/** One built-in evaluation definition, localized. */
function evalDef(t: T, id: string): EvalDef {
  const def = EVAL_PROMPTS[id];
  if (!def) throw new Error(`study.json: unknown built-in evaluation "${id}"`);
  return {
    id,
    name: t(`tpl.eval.${id}.name` as TranslationKey),
    description: t(`tpl.eval.${id}.desc` as TranslationKey),
    prompt: def.prompt,
  };
}

/** Shared evaluation definitions the templates draw from. */
export function buildPresetEvalDefs(t: T): EvalDef[] {
  return STUDY.coreEvals.map((id) => evalDef(t, id));
}

/** Build the full built-in template library for a given language. */
export function buildPresetEvalTemplates(t: T): EvalTemplate[] {
  return Object.entries(TEMPLATE_EVALS).map(([id, evalIds]) => ({
    id,
    name: t(`tpl.evalSet.${id}.name` as TranslationKey),
    builtin: true,
    evals: evalIds.map((evalId) => evalDef(t, evalId)),
  }));
}

/**
 * The evaluation set a fresh install starts with: the internal-meeting watchers,
 * matching the decision lens that an unclassified recording falls back to.
 */
export function defaultEvalDefs(t: T): EvalDef[] {
  const tpl = buildPresetEvalTemplates(t).find((x) => x.id === "tpl-internal");
  return (tpl?.evals ?? []).map((e) => ({ ...e }));
}

/**
 * A map of every built-in evaluation id → its localized name/description, used
 * to relabel the active evaluation set when the language changes.
 */
export function buildBuiltinEvalLabels(t: T): Map<string, { name: string; description: string }> {
  const labels = new Map<string, { name: string; description: string }>();
  for (const tpl of buildPresetEvalTemplates(t)) {
    for (const e of tpl.evals) labels.set(e.id, { name: e.name, description: e.description });
  }
  return labels;
}

/**
 * Order-sensitive signature of an evaluation set (id|name|prompt per item). Used
 * as the analysis cache key's eval component, to detect when the set changed
 * since the last analysis (stale findings), and to match a live set back to the
 * template it came from. Accepts both EvalDef[] and the runtime Evaluation[].
 */
export function evalSignature(evals: { id: string; name: string; prompt: string }[]): string {
  return evals.map((e) => `${e.id}|${e.name}|${e.prompt}`).join("\n");
}

/**
 * The template whose evals exactly match the current set, or null when the set
 * has been hand-edited into a custom one. Drives the "current template" label in
 * the timeline + the template picker's selected value.
 */
export function findActiveTemplate(
  templates: EvalTemplate[],
  evaluations: { id: string; name: string; prompt: string }[]
): EvalTemplate | null {
  const sig = evalSignature(evaluations);
  return templates.find((tpl) => evalSignature(tpl.evals) === sig) ?? null;
}

/** Build runtime evaluations from definitions, preserving runtime state by id. */
export function evalsFromDefs(defs: EvalDef[], prev: Evaluation[] = []): Evaluation[] {
  return defs.map((d) => {
    const existing = prev.find((e) => e.id === d.id);
    return {
      ...d,
      status: existing?.status ?? "idle",
      lastRunAt: existing?.lastRunAt,
      result: existing?.result,
    };
  });
}
