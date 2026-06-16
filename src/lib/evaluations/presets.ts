import type { EvalDef, EvalTemplate, Evaluation } from "../types";

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
  },
  {
    id: "pushback",
    name: "該 push back 的時機",
    description: "對方提出不合理條件或單方面有利的條款",
    prompt:
      "Identify moments where I ('me') should push back. Look for one-sided terms, unreasonable " +
      "demands, assumptions stated as facts, or concessions being extracted from me without reciprocity. " +
      "If found, flag it and suggest specifically what to push back on.",
  },
  {
    id: "unanswered",
    name: "未回答的問題",
    description: "我方提問但對方含糊帶過、沒正面回應",
    prompt:
      "Track questions I ('me') asked that the other party did NOT clearly answer — they deflected, " +
      "gave a vague response, or changed the subject. Flag each open question so I can re-ask it. " +
      "Quote my original question and their evasive reply.",
  },
  {
    id: "checklist",
    name: "流程遺漏",
    description: "依會議類型該問卻還沒問的項目",
    prompt:
      "Given the meeting context provided, identify important topics or questions that are standard for " +
      "this kind of meeting (interview or negotiation) but have NOT yet been covered. Flag what's missing " +
      "so I can raise it before the meeting ends.",
  },
  {
    id: "claims",
    name: "待查證宣稱",
    description: "對方提出的可驗證事實主張，標記為之後查證",
    prompt:
      "Extract concrete, verifiable factual claims made by the other party ('them') — numbers, dates, " +
      "credentials, references, commitments. These are things worth fact-checking later. List each claim. " +
      "Severity is informational unless a claim is central to the deal/decision.",
  },
];

// Interview-focused evaluations.
const INTERVIEW_DEFS: EvalDef[] = [
  {
    id: "iv-exaggeration",
    name: "誇大 / 灌水偵測",
    description: "候選人對技能、年資、貢獻的誇大或含糊其詞",
    prompt:
      "You are helping interview a candidate ('them'). Flag exaggeration or inflation: vague ownership " +
      "claims ('we built…' vs concrete personal contribution), inflated scope/seniority/years, buzzwords " +
      "without substance, or dodging specifics when asked to go deeper. Quote the suspicious lines.",
  },
  {
    id: "iv-consistency",
    name: "經歷一致性",
    description: "候選人前後說法 / 時間線 / 數字是否一致",
    prompt:
      "Track the candidate's statements about roles, timelines, team sizes, and metrics. Flag any internal " +
      "contradiction or timeline that doesn't add up, citing the conflicting quotes.",
  },
  {
    id: "iv-redflags",
    name: "紅旗訊號",
    description: "態度、責任歸屬、對前東家/同事的描述等警訊",
    prompt:
      "Watch for behavioral red flags: blaming others for all failures, lack of accountability, " +
      "dismissiveness, ethical concerns, or contradictions about why they left roles. Flag with the quote.",
  },
  {
    id: "iv-followup",
    name: "值得追問",
    description: "候選人提到、但你還沒深入追問的點",
    prompt:
      "Identify claims or topics the candidate raised that deserve a deeper follow-up question and that I " +
      "('me') have not yet probed. Suggest the specific follow-up to ask.",
  },
];

// Negotiation / business-deal evaluations.
const NEGOTIATION_DEFS: EvalDef[] = [
  PRESET_EVAL_DEFS[0], // deception / pressure tactics
  PRESET_EVAL_DEFS[1], // when to push back
  {
    id: "ng-concessions",
    name: "讓步追蹤",
    description: "雙方已提出/已同意的讓步與條件",
    prompt:
      "Track concessions and commitments on both sides: what each party has offered, conceded, or agreed to. " +
      "Flag asymmetric exchanges where I ('me') gave more than I received. Summarize the current state of the deal.",
  },
  PRESET_EVAL_DEFS[2], // unanswered questions
  PRESET_EVAL_DEFS[4], // claims to verify
];

/** Built-in template library. The first is the default active set. */
export const PRESET_EVAL_TEMPLATES: EvalTemplate[] = [
  { id: "tpl-general", name: "通用 / General", builtin: true, evals: PRESET_EVAL_DEFS },
  { id: "tpl-interview", name: "面試 / Interview", builtin: true, evals: INTERVIEW_DEFS },
  { id: "tpl-negotiation", name: "談判 / Negotiation", builtin: true, evals: NEGOTIATION_DEFS },
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
