import { translate } from "../../i18n/messages";
import type { AppLanguage, EvalDef } from "../types";
import type { Claim } from "./types";

/**
 * Red-line live guardrails (design D9/§7.3): when a meeting is linked to a
 * thread, that thread's (and its company's) active `redline` claims become
 * per-meeting evaluations, so the coach flags the user the moment they drift
 * toward revealing something they must not. Rides the existing eval engine —
 * no new pipeline. Injected on meeting start, removed on stop.
 */

export const REDLINE_EVAL_PREFIX = "redline:";

export function isRedlineEvalId(id: string): boolean {
  return id.startsWith(REDLINE_EVAL_PREFIX);
}

export function buildRedlineEvals(claims: Claim[], language: AppLanguage): EvalDef[] {
  return claims
    .filter((c) => c.category === "redline" && c.status === "active")
    .map((c) => ({
      id: `${REDLINE_EVAL_PREFIX}${c.id}`,
      name: `🚨 ${translate(language, "accounts.redline.evalName")}`,
      description: c.text,
      prompt:
        `RED LINE — the user (ME) must NOT reveal, confirm, or hint at the following: "${c.text}". ` +
        "Watch ME's utterances only. Flag as critical the moment ME reveals it, partially discloses it, " +
        "or is being steered toward it and starts to engage. Do NOT flag the counterpart merely asking. " +
        "Quote ME's exact words as evidence.",
    }));
}
