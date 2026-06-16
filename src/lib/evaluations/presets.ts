import type { EvalDef, Evaluation } from "../types";

/**
 * Built-in evaluation definitions that ship with Parley. Used as the default
 * `settings.evaluations`; the user can edit/add/remove them in Settings.
 */
export const PRESET_EVAL_DEFS: EvalDef[] = [
  {
    id: "deception",
    name: "詐術 / 不一致偵測",
    description: "對方說法前後矛盾、迴避、誇大或施壓話術",
    prompt:
      "You are monitoring the OTHER party ('them') for signs of deception or manipulation. " +
      "Look for: internal contradictions across what they've said, evasive non-answers, " +
      "unverifiable grand claims, moving goalposts, false urgency, or pressure tactics. " +
      "Flag only when you have concrete textual evidence. Cite the exact conflicting or suspicious quotes.",
    mode: "auto",
    autoEverySec: 45,
  },
  {
    id: "pushback",
    name: "該 push back 的時機",
    description: "對方提出不合理條件或單方面有利的條款",
    prompt:
      "Identify moments where I ('me') should push back. Look for one-sided terms, unreasonable " +
      "demands, assumptions stated as facts, or concessions being extracted from me without reciprocity. " +
      "If found, flag it and suggest specifically what to push back on.",
    mode: "auto",
    autoEverySec: 60,
  },
  {
    id: "unanswered",
    name: "未回答的問題",
    description: "我方提問但對方含糊帶過、沒正面回應",
    prompt:
      "Track questions I ('me') asked that the other party did NOT clearly answer — they deflected, " +
      "gave a vague response, or changed the subject. Flag each open question so I can re-ask it. " +
      "Quote my original question and their evasive reply.",
    mode: "auto",
    autoEverySec: 60,
  },
  {
    id: "checklist",
    name: "流程遺漏",
    description: "依會議類型該問卻還沒問的項目",
    prompt:
      "Given the meeting context provided, identify important topics or questions that are standard for " +
      "this kind of meeting (interview or negotiation) but have NOT yet been covered. Flag what's missing " +
      "so I can raise it before the meeting ends.",
    mode: "manual",
  },
  {
    id: "claims",
    name: "待查證宣稱",
    description: "對方提出的可驗證事實主張，標記為之後查證",
    prompt:
      "Extract concrete, verifiable factual claims made by the other party ('them') — numbers, dates, " +
      "credentials, references, commitments. These are things worth fact-checking later. List each claim. " +
      "Severity is informational unless a claim is central to the deal/decision.",
    mode: "manual",
  },
];

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
