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
        "You are monitoring the OTHER party ('them') for active DECEPTION or MANIPULATION (bad-faith tactics) " +
        "— NOT mere inconsistency. Look for: evasive non-answers, bluffing, unverifiable grand claims, moving " +
        "the goalposts, manufactured/false urgency, or pressure tactics meant to mislead or coerce. A legitimate " +
        "constraint, an honest 'I don't know', or a stated change of position for a real reason is NOT deception. " +
        "Flag only with concrete textual evidence; quote the suspicious lines.",
    },
    {
      id: "inconsistency",
      name: t("tpl.eval.inconsistency.name"),
      description: t("tpl.eval.inconsistency.desc"),
      prompt:
        "Track whether the OTHER party ('them') CONTRADICTS THEMSELVES: a later statement that genuinely " +
        "conflicts with something they said earlier — a number, commitment, timeline, position, or fact that " +
        "changed WITHOUT a stated reason. Flag only a real contradiction and cite BOTH conflicting quotes with " +
        "their timestamps. A stated change of position for a legitimate reason, or a constraint/concern they " +
        "raise (e.g. 'if I sign this as-is I'd breach a prior commitment'), is NOT an inconsistency — do not flag it.",
    },
    {
      id: "pushback",
      name: t("tpl.eval.pushback.name"),
      description: t("tpl.eval.pushback.desc"),
      prompt:
        "Identify moments where I ('me') should push back. Pushing back is NOT only arguing a term — it also " +
        "means calling out vague over-promising or grand 'big-picture' pitches with no specifics, and pressing " +
        "when the other party blurs focus or paints a rosy picture to dodge a hard point. Look for: one-sided " +
        "terms, unreasonable demands, assumptions stated as facts, concessions extracted from me without " +
        "reciprocity, or hand-wavy promises I should pin down. Flag it and suggest specifically what to push " +
        "back on or what concrete commitment to ask for.",
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
    {
      id: "leverage",
      name: t("tpl.eval.leverage.name"),
      description: t("tpl.eval.leverage.desc"),
      prompt:
        "Apply the principled-negotiation 'invent OPTIONS for mutual gain' principle: spot chances to EXPAND " +
        "THE PIE rather than just split it — issues the two sides value DIFFERENTLY that can be traded, package " +
        "deals, or contingent terms. Using the meeting context and MY stated target/direction, surface a concrete " +
        "option ME can propose (what ME gives, what ME asks for in return) that moves toward MY goal while still " +
        "being attractive to THEM — so ME negotiates on value, not just position.",
    },
  ];
}

/**
 * Principled-negotiation evaluations (Fisher & Ury, "Getting to Yes") — interests
 * over positions, BATNA, ZOPA, and objective criteria. They lean on the per-deal
 * setup (my BATNA / target / bottom line) injected into the prompt context, so
 * they're bundled into the negotiation-flavoured templates rather than the general
 * default set.
 */
function principledDefs(t: T): EvalDef[] {
  return [
    {
      id: "interests",
      name: t("tpl.eval.interests.name"),
      description: t("tpl.eval.interests.desc"),
      prompt:
        "Apply 'focus on INTERESTS, not positions'. A position is what a side DEMANDS; the interest is the " +
        "underlying WHY — the need, fear, or goal behind it. Flag when the conversation is locked on positions, " +
        "name the likely interest behind THEM's position (and behind MINE), and suggest how ME can satisfy the " +
        "interest instead of haggling the position. Quote the positional line.",
    },
    {
      id: "batna",
      name: t("tpl.eval.batna.name"),
      description: t("tpl.eval.batna.desc"),
      prompt:
        "Track BATNA (Best Alternative To a Negotiated Agreement) — each side's walk-away option, the true " +
        "source of leverage. Using MY BATNA and bottom line from the setup, flag: signals about THEM's " +
        "alternatives (strong or weak), moments THEM tests or probes MY alternative, and when the conversation " +
        "pushes ME toward MY bottom line. Note who currently holds the stronger BATNA and what it means for MY leverage.",
    },
    {
      id: "zopa",
      name: t("tpl.eval.zopa.name"),
      description: t("tpl.eval.zopa.desc"),
      prompt:
        "Map the ZOPA (Zone Of Possible Agreement) on the key terms (price, scope, timing, equity, …): track " +
        "what each side reveals about their acceptable range versus MY target and bottom line from the setup. " +
        "Flag when an offer falls OUTSIDE the likely ZOPA, when the revealed ranges OVERLAP (a deal is reachable), " +
        "or when a number is still missing to locate the zone. Be concrete about which term and the implied range.",
    },
    {
      id: "criteria",
      name: t("tpl.eval.criteria.name"),
      description: t("tpl.eval.criteria.desc"),
      prompt:
        "Apply 'insist on OBJECTIVE CRITERIA'. Flag when a number or term is justified by will, pressure, or " +
        "'that's just our policy' rather than an objective standard (market rate, precedent, independent " +
        "benchmark, a formula). Name the objective criterion ME could anchor to so the term is decided on merit, " +
        "not power. Quote the unsupported claim.",
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
  const [deception, inconsistency, pushback, unanswered, , claims, topicShift, leverage] = core;
  const [interests, batna, zopa, criteria] = principledDefs(t);
  // The clean principled-negotiation set (interests/BATNA/ZOPA/criteria + options
  // + the key tactics), offered as its own template.
  const principled: EvalDef[] = [interests, batna, zopa, criteria, leverage, pushback, deception, inconsistency];

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
    // (sl-nextstep retired by the C integration: the board's next-step slot +
    // deterministic gate own that concern — one home, no LLM pass.)
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
    leverage, // trade-offs to steer toward my goal
    nextMove(t), // recommend the next move
  ];

  const dealDefs: EvalDef[] = [
    interests, // interests, not positions
    batna, // BATNA / walk-away leverage
    zopa, // zone of possible agreement
    criteria, // objective criteria
    deception, // deception / pressure tactics
    inconsistency, // self-contradiction
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
    leverage, // trade-offs to steer toward my goal
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
    deception, // deception / manipulation
    inconsistency, // self-contradiction
    topicShift, // topic shift / focus dilution
  ];

  return [
    { id: "tpl-general", name: t("tpl.evalSet.tpl-general.name"), builtin: true, evals: core },
    { id: "tpl-principled", name: t("tpl.evalSet.tpl-principled.name"), builtin: true, evals: principled },
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
