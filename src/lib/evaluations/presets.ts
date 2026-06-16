import type { EvalDef, EvalTemplate, Evaluation } from "../types";

/**
 * Built-in evaluation definitions that ship with Parley. Used as the default
 * `settings.evaluations`; the user can edit/add/remove them in Settings.
 *
 * The built-in template library below maps onto the use-cases Parley markets:
 * job interviews, salary negotiations, sales calls, deal-making, and diligence
 * calls — plus a general-purpose set.
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
      "this kind of meeting but have NOT yet been covered. Flag what's missing so I can raise it before " +
      "the meeting ends.",
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
  {
    id: "topic-shift",
    name: "話題偏移 / 模糊焦點",
    description: "對方突然轉移話題、答非所問、或用無關細節稀釋你提出的重點",
    prompt:
      "Watch for the other party ('them') steering away from the point: a sudden topic change, answering a " +
      "different question than the one asked, retreating into vague generalities, or burying the issue under " +
      "irrelevant detail — especially right after I ('me') raised something they'd rather avoid. When it " +
      "happens, flag it, name the specific point they slid off, and suggest how I can steer back. This helps " +
      "a less-experienced operator catch deflection in the moment.",
  },
];

/**
 * Forward-looking "what should I do next" evaluation. Beyond flagging issues,
 * this proactively recommends my next move — the seed of Parley's coaching /
 * next-step-recommendation direction.
 */
const NEXT_MOVE: EvalDef = {
  id: "nextmove",
  name: "下一步建議 / Next move",
  description: "根據目前進展，建議我接下來該說 / 問 / 提出的條件",
  prompt:
    "Based on the conversation so far, recommend the single best next move for me ('me') to advance my goal — " +
    "the specific question to ask, point to make, or term/number to propose right now. Make it concrete and " +
    "say it in words I could use, plus one short line on why now. Only surface a new suggestion when the " +
    "situation has meaningfully moved.",
};

// Job-interview evaluations.
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
  PRESET_EVAL_DEFS[5], // topic shift / focus dilution (candidate dodging)
];

// Sales-call evaluations (qualification-driven, MEDDICC-flavored).
const SALES_DEFS: EvalDef[] = [
  {
    id: "sl-qualification",
    name: "資格判定缺口 (MEDDICC)",
    description: "Metrics / 決策者 / 決策標準 / 痛點 / 流程 / Champion 等尚未釐清的項目",
    prompt:
      "You are helping qualify a sales opportunity. Track the MEDDICC-style dimensions: quantified Metrics, " +
      "Economic buyer, Decision criteria, Decision process, identified Pain, and a Champion. Flag which " +
      "dimensions are still unknown or weak so I ('me') can ask about them before the call ends.",
  },
  {
    id: "sl-pain",
    name: "痛點深度與急迫性",
    description: "對方痛點是否具體、可量化、有急迫性",
    prompt:
      "Assess the prospect's pain. Flag when their problem is stated vaguely, is not quantified (cost, time, " +
      "risk), or lacks urgency / a compelling event. Suggest the specific question that would deepen or " +
      "quantify the pain.",
  },
  {
    id: "sl-objections",
    name: "異議 / 顧慮",
    description: "對方提出的反對意見或顧慮，標記尚未被處理的",
    prompt:
      "Detect objections or concerns the prospect ('them') raises — price, timing, fit, competitor, risk, " +
      "authority. Flag each one, and especially any that I ('me') have NOT yet addressed. Quote the objection.",
  },
  {
    id: "sl-nextstep",
    name: "下一步承諾",
    description: "是否約定明確、雙方同意的下一步",
    prompt:
      "Check whether a concrete, mutually-agreed next step has been established (a scheduled meeting, a trial, " +
      "an intro to the economic buyer). Flag if the call is heading toward ending without a committed next step.",
  },
  PRESET_EVAL_DEFS[4], // claims to verify
  PRESET_EVAL_DEFS[5], // topic shift / focus dilution
  NEXT_MOVE, // recommend the next move
];

// Salary-negotiation evaluations.
const SALARY_DEFS: EvalDef[] = [
  {
    id: "sa-market",
    name: "行情 / 薪酬主張",
    description: "對方對市場行情、預算、薪酬結構的主張，標記待查證",
    prompt:
      "The other party ('them') is the employer/recruiter in a compensation discussion. Extract claims about " +
      "market rate, internal bands, budget limits, or 'this is the most we can do' — these are negotiable " +
      "positions, not facts. List each so I ('me') can verify or challenge it.",
  },
  {
    id: "sa-components",
    name: "薪酬組成追蹤",
    description: "底薪 / 獎金 / 股票 / 簽約金 / 福利等各項與已談到的條件",
    prompt:
      "Track every compensation component discussed: base, bonus, equity (amount, vesting, strike), sign-on, " +
      "benefits, title, start date, review timing. Summarize what has been offered vs. still open, and flag " +
      "where I ('me') gave ground without getting something back.",
  },
  PRESET_EVAL_DEFS[1], // when to push back
  {
    id: "sa-pressure",
    name: "錨定 / 施壓話術",
    description: "錨定、人為期限、take-it-or-leave-it 等施壓手法",
    prompt:
      "Watch for negotiation pressure tactics from the employer: low anchoring, artificial deadlines, " +
      "'exploding' offers, take-it-or-leave-it framing, or appeals to fairness/policy to shut down asks. " +
      "Flag the tactic and suggest how I ('me') can hold my position.",
  },
  PRESET_EVAL_DEFS[2], // unanswered questions
  PRESET_EVAL_DEFS[5], // topic shift / focus dilution
  NEXT_MOVE, // recommend the next move
];

// Deal-making / business-negotiation evaluations.
const DEAL_DEFS: EvalDef[] = [
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
  PRESET_EVAL_DEFS[5], // topic shift / focus dilution
  NEXT_MOVE, // recommend the next move
];

// Diligence-call evaluations (verify claims, surface risk).
const DILIGENCE_DEFS: EvalDef[] = [
  {
    id: "dd-claims",
    name: "重點宣稱待查證",
    description: "財務 / 客戶 / 成長 / 法務等可驗證主張，列為查證清單",
    prompt:
      "This is a due-diligence call. Extract every concrete, verifiable claim the other party ('them') makes " +
      "about financials, revenue, growth, customers, churn, headcount, legal status, or IP. List each as a " +
      "diligence item to verify against documents later, quoting the claim.",
  },
  {
    id: "dd-risk",
    name: "風險訊號",
    description: "財務 / 法務 / 營運 / 團隊面的風險或不一致",
    prompt:
      "Surface risk signals: financial, legal, operational, customer-concentration, or team risks, and any " +
      "numbers or statements that are internally inconsistent or seem too good. Flag each with the quote and " +
      "why it warrants follow-up.",
  },
  PRESET_EVAL_DEFS[2], // unanswered questions
  {
    id: "dd-checklist",
    name: "盡調項目遺漏",
    description: "標準盡職調查面向中尚未觸及的部分",
    prompt:
      "Given a due-diligence context, identify standard areas that have NOT yet been covered — financials, " +
      "customer concentration, churn/retention, unit economics, legal/compliance, cap table, key-person risk, " +
      "tech debt/security. Flag the gaps so I ('me') can raise them before the call ends.",
  },
  PRESET_EVAL_DEFS[0], // deception / inconsistency
  PRESET_EVAL_DEFS[5], // topic shift / focus dilution
];

/** Built-in template library. The first is the default active set. */
export const PRESET_EVAL_TEMPLATES: EvalTemplate[] = [
  { id: "tpl-general", name: "通用 / General", builtin: true, evals: PRESET_EVAL_DEFS },
  { id: "tpl-interview", name: "面試 / Job interview", builtin: true, evals: INTERVIEW_DEFS },
  { id: "tpl-salary", name: "薪資談判 / Salary negotiation", builtin: true, evals: SALARY_DEFS },
  { id: "tpl-sales", name: "銷售電話 / Sales call", builtin: true, evals: SALES_DEFS },
  { id: "tpl-negotiation", name: "商務談判 / Deal-making", builtin: true, evals: DEAL_DEFS },
  { id: "tpl-diligence", name: "盡職調查 / Diligence call", builtin: true, evals: DILIGENCE_DEFS },
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
