import type { EvalDef, EvalTemplate, Evaluation } from "../types";
import type { TranslationKey } from "../../i18n/messages";

/**
 * Built-in evaluation definitions and the template library that ship with
 * Parley, covering the use-cases Parley markets: job interviews, salary
 * negotiations, sales calls, deal-making, and diligence calls — plus a
 * general-purpose set.
 *
 * Display strings (names/descriptions) are looked up through i18n so built-in
 * templates follow the UI language. The `prompt` field is the instruction handed
 * to the LLM and stays in English on purpose — it's model input, not UI.
 */

/** A translate function bound to the current language: `(key) => string`. */
type T = (key: TranslationKey) => string;

/** Core, general-purpose evaluation definitions (the default active set). */
export function buildPresetEvalDefs(t: T): EvalDef[] {
  return [
    {
      id: "deception",
      name: t("tpl.eval.deception.name"),
      description: t("tpl.eval.deception.desc"),
      prompt:
        "You are monitoring the OTHER party ('them') for signs of deception or manipulation. " +
        "Look for: internal contradictions across what they've said, evasive non-answers, " +
        "unverifiable grand claims, moving goalposts, false urgency, or pressure tactics. " +
        "Flag only when you have concrete textual evidence. Cite the exact conflicting or suspicious quotes.",
    },
    {
      id: "pushback",
      name: t("tpl.eval.pushback.name"),
      description: t("tpl.eval.pushback.desc"),
      prompt:
        "Identify moments where I ('me') should push back. Look for one-sided terms, unreasonable " +
        "demands, assumptions stated as facts, or concessions being extracted from me without reciprocity. " +
        "If found, flag it and suggest specifically what to push back on.",
    },
    {
      id: "unanswered",
      name: t("tpl.eval.unanswered.name"),
      description: t("tpl.eval.unanswered.desc"),
      prompt:
        "Track questions I ('me') asked that the other party did NOT clearly answer — they deflected, " +
        "gave a vague response, or changed the subject. Flag each open question so I can re-ask it. " +
        "Quote my original question and their evasive reply.",
    },
    {
      id: "checklist",
      name: t("tpl.eval.checklist.name"),
      description: t("tpl.eval.checklist.desc"),
      prompt:
        "Given the meeting context provided, identify important topics or questions that are standard for " +
        "this kind of meeting but have NOT yet been covered. Flag what's missing so I can raise it before " +
        "the meeting ends.",
    },
    {
      id: "claims",
      name: t("tpl.eval.claims.name"),
      description: t("tpl.eval.claims.desc"),
      prompt:
        "Extract concrete, verifiable factual claims made by the other party ('them') — numbers, dates, " +
        "credentials, references, commitments. These are things worth fact-checking later. List each claim. " +
        "Severity is informational unless a claim is central to the deal/decision.",
    },
    {
      id: "topic-shift",
      name: t("tpl.eval.topic-shift.name"),
      description: t("tpl.eval.topic-shift.desc"),
      prompt:
        "Watch for the other party ('them') steering away from the point: a sudden topic change, answering a " +
        "different question than the one asked, retreating into vague generalities, or burying the issue under " +
        "irrelevant detail — especially right after I ('me') raised something they'd rather avoid. When it " +
        "happens, flag it, name the specific point they slid off, and suggest how I can steer back. This helps " +
        "a less-experienced operator catch deflection in the moment.",
    },
  ];
}

/**
 * Forward-looking "what should I do next" evaluation. Beyond flagging issues,
 * this proactively recommends my next move.
 */
function nextMove(t: T): EvalDef {
  return {
    id: "nextmove",
    name: t("tpl.eval.nextmove.name"),
    description: t("tpl.eval.nextmove.desc"),
    prompt:
      "Based on the conversation so far, recommend the single best next move for me ('me') to advance my goal — " +
      "the specific question to ask, point to make, or term/number to propose right now. Make it concrete and " +
      "say it in words I could use, plus one short line on why now. Only surface a new suggestion when the " +
      "situation has meaningfully moved.",
  };
}

/** Build the full built-in template library for a given language. */
export function buildPresetEvalTemplates(t: T): EvalTemplate[] {
  const core = buildPresetEvalDefs(t);
  const [deception, pushback, unanswered, , claims, topicShift] = core;

  const interviewDefs: EvalDef[] = [
    {
      id: "iv-exaggeration",
      name: t("tpl.eval.iv-exaggeration.name"),
      description: t("tpl.eval.iv-exaggeration.desc"),
      prompt:
        "You are helping interview a candidate ('them'). Flag exaggeration or inflation: vague ownership " +
        "claims ('we built…' vs concrete personal contribution), inflated scope/seniority/years, buzzwords " +
        "without substance, or dodging specifics when asked to go deeper. Quote the suspicious lines.",
    },
    {
      id: "iv-consistency",
      name: t("tpl.eval.iv-consistency.name"),
      description: t("tpl.eval.iv-consistency.desc"),
      prompt:
        "Track the candidate's statements about roles, timelines, team sizes, and metrics. Flag any internal " +
        "contradiction or timeline that doesn't add up, citing the conflicting quotes.",
    },
    {
      id: "iv-redflags",
      name: t("tpl.eval.iv-redflags.name"),
      description: t("tpl.eval.iv-redflags.desc"),
      prompt:
        "Watch for behavioral red flags: blaming others for all failures, lack of accountability, " +
        "dismissiveness, ethical concerns, or contradictions about why they left roles. Flag with the quote.",
    },
    {
      id: "iv-followup",
      name: t("tpl.eval.iv-followup.name"),
      description: t("tpl.eval.iv-followup.desc"),
      prompt:
        "Identify claims or topics the candidate raised that deserve a deeper follow-up question and that I " +
        "('me') have not yet probed. Suggest the specific follow-up to ask.",
    },
    topicShift, // topic shift / focus dilution (candidate dodging)
  ];

  const salesDefs: EvalDef[] = [
    {
      id: "sl-qualification",
      name: t("tpl.eval.sl-qualification.name"),
      description: t("tpl.eval.sl-qualification.desc"),
      prompt:
        "You are helping qualify a sales opportunity. Track the MEDDICC-style dimensions: quantified Metrics, " +
        "Economic buyer, Decision criteria, Decision process, identified Pain, and a Champion. Flag which " +
        "dimensions are still unknown or weak so I ('me') can ask about them before the call ends.",
    },
    {
      id: "sl-pain",
      name: t("tpl.eval.sl-pain.name"),
      description: t("tpl.eval.sl-pain.desc"),
      prompt:
        "Assess the prospect's pain. Flag when their problem is stated vaguely, is not quantified (cost, time, " +
        "risk), or lacks urgency / a compelling event. Suggest the specific question that would deepen or " +
        "quantify the pain.",
    },
    {
      id: "sl-objections",
      name: t("tpl.eval.sl-objections.name"),
      description: t("tpl.eval.sl-objections.desc"),
      prompt:
        "Detect objections or concerns the prospect ('them') raises — price, timing, fit, competitor, risk, " +
        "authority. Flag each one, and especially any that I ('me') have NOT yet addressed. Quote the objection.",
    },
    {
      id: "sl-nextstep",
      name: t("tpl.eval.sl-nextstep.name"),
      description: t("tpl.eval.sl-nextstep.desc"),
      prompt:
        "Check whether a concrete, mutually-agreed next step has been established (a scheduled meeting, a trial, " +
        "an intro to the economic buyer). Flag if the call is heading toward ending without a committed next step.",
    },
    claims, // claims to verify
    topicShift, // topic shift / focus dilution
    nextMove(t), // recommend the next move
  ];

  const salaryDefs: EvalDef[] = [
    {
      id: "sa-market",
      name: t("tpl.eval.sa-market.name"),
      description: t("tpl.eval.sa-market.desc"),
      prompt:
        "The other party ('them') is the employer/recruiter in a compensation discussion. Extract claims about " +
        "market rate, internal bands, budget limits, or 'this is the most we can do' — these are negotiable " +
        "positions, not facts. List each so I ('me') can verify or challenge it.",
    },
    {
      id: "sa-components",
      name: t("tpl.eval.sa-components.name"),
      description: t("tpl.eval.sa-components.desc"),
      prompt:
        "Track every compensation component discussed: base, bonus, equity (amount, vesting, strike), sign-on, " +
        "benefits, title, start date, review timing. Summarize what has been offered vs. still open, and flag " +
        "where I ('me') gave ground without getting something back.",
    },
    pushback, // when to push back
    {
      id: "sa-pressure",
      name: t("tpl.eval.sa-pressure.name"),
      description: t("tpl.eval.sa-pressure.desc"),
      prompt:
        "Watch for negotiation pressure tactics from the employer: low anchoring, artificial deadlines, " +
        "'exploding' offers, take-it-or-leave-it framing, or appeals to fairness/policy to shut down asks. " +
        "Flag the tactic and suggest how I ('me') can hold my position.",
    },
    unanswered, // unanswered questions
    topicShift, // topic shift / focus dilution
    nextMove(t), // recommend the next move
  ];

  const dealDefs: EvalDef[] = [
    deception, // deception / pressure tactics
    pushback, // when to push back
    {
      id: "ng-concessions",
      name: t("tpl.eval.ng-concessions.name"),
      description: t("tpl.eval.ng-concessions.desc"),
      prompt:
        "Track concessions and commitments on both sides: what each party has offered, conceded, or agreed to. " +
        "Flag asymmetric exchanges where I ('me') gave more than I received. Summarize the current state of the deal.",
    },
    unanswered, // unanswered questions
    claims, // claims to verify
    topicShift, // topic shift / focus dilution
    nextMove(t), // recommend the next move
  ];

  const diligenceDefs: EvalDef[] = [
    {
      id: "dd-claims",
      name: t("tpl.eval.dd-claims.name"),
      description: t("tpl.eval.dd-claims.desc"),
      prompt:
        "This is a due-diligence call. Extract every concrete, verifiable claim the other party ('them') makes " +
        "about financials, revenue, growth, customers, churn, headcount, legal status, or IP. List each as a " +
        "diligence item to verify against documents later, quoting the claim.",
    },
    {
      id: "dd-risk",
      name: t("tpl.eval.dd-risk.name"),
      description: t("tpl.eval.dd-risk.desc"),
      prompt:
        "Surface risk signals: financial, legal, operational, customer-concentration, or team risks, and any " +
        "numbers or statements that are internally inconsistent or seem too good. Flag each with the quote and " +
        "why it warrants follow-up.",
    },
    unanswered, // unanswered questions
    {
      id: "dd-checklist",
      name: t("tpl.eval.dd-checklist.name"),
      description: t("tpl.eval.dd-checklist.desc"),
      prompt:
        "Given a due-diligence context, identify standard areas that have NOT yet been covered — financials, " +
        "customer concentration, churn/retention, unit economics, legal/compliance, cap table, key-person risk, " +
        "tech debt/security. Flag the gaps so I ('me') can raise them before the call ends.",
    },
    deception, // deception / inconsistency
    topicShift, // topic shift / focus dilution
  ];

  return [
    { id: "tpl-general", name: t("tpl.evalSet.tpl-general.name"), builtin: true, evals: core },
    { id: "tpl-interview", name: t("tpl.evalSet.tpl-interview.name"), builtin: true, evals: interviewDefs },
    { id: "tpl-salary", name: t("tpl.evalSet.tpl-salary.name"), builtin: true, evals: salaryDefs },
    { id: "tpl-sales", name: t("tpl.evalSet.tpl-sales.name"), builtin: true, evals: salesDefs },
    { id: "tpl-negotiation", name: t("tpl.evalSet.tpl-negotiation.name"), builtin: true, evals: dealDefs },
    { id: "tpl-diligence", name: t("tpl.evalSet.tpl-diligence.name"), builtin: true, evals: diligenceDefs },
  ];
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
