// MEETING KIND × ANALYSIS LENS — two layers that used to be one.
//
// Before this split there was a single axis: which WATCHERS run (the evaluation
// set). The analysis FRAME was hard-coded adversarial — findings carried
// me/them lanes and a "did ME successfully rebut THEM" resolved flag, and the
// brief always had a "what fell short / how to improve" section. So a design
// review filed under the 通用 template still came back scored as a negotiation
// ME had half-lost. Swapping the watcher list could never fix that; the shape
// itself had to become a choice.
//
//   KIND  — what the meeting WAS. User-visible, per-recording, auto-detected
//           from the transcript and overridable from the report page.
//   LENS  — the SHAPE that kind earns: which finding fields are meaningful,
//           and which sections the brief is written in.
//
// Four kinds collapse onto three lenses because 議價 and 對手談判 want the same
// OUTPUT (both are adversarial, both want resolved/side) while wanting
// different WATCHERS — which is exactly the axis evaluations/presets still owns.

import { evalSignature } from "../evaluations/presets";
import type { AnalysisLens, MeetingKind } from "../types";

/**
 * Signature of everything that shapes an analysis: the kind (which picks the
 * lens, and so the output SHAPE) plus the watcher list. Findings are stale when
 * this differs from the one they were produced under.
 *
 * The kind has to be in here. Watchers alone would miss the case where someone
 * switches an internal meeting to "sales" while already sitting on the sales
 * watcher list — the eval signature never moves, but the report is now written
 * to the wrong shape and nothing would have said so.
 */
export function analysisSignature(
  kind: MeetingKind | null | undefined,
  evals: { id: string; name: string; prompt: string }[]
): string {
  return `${kind ?? "?"}\n${evalSignature(evals)}`;
}

/** Every kind, in picker order. */
export const MEETING_KINDS: readonly MeetingKind[] = ["internal", "sales", "pricing", "rivalry"];

/** The output shape each kind earns. */
const LENS_OF: Record<MeetingKind, AnalysisLens> = {
  internal: "decision",
  sales: "opportunity",
  pricing: "adversarial",
  rivalry: "adversarial",
};

/** The built-in evaluation template each kind activates. */
export const EVAL_TEMPLATE_OF: Record<MeetingKind, string> = {
  internal: "tpl-internal",
  sales: "tpl-sales",
  pricing: "tpl-pricing",
  rivalry: "tpl-rivalry",
};

/**
 * The lens for a kind. `null` (never classified — an old entry, or a failed
 * detection pass) reads as "internal": a meeting record is the safe default,
 * because framing a genuine sales call as a plain record loses advice, while
 * framing a design review as a negotiation actively lies about it.
 */
export function lensOf(kind: MeetingKind | null | undefined): AnalysisLens {
  return kind ? LENS_OF[kind] : "decision";
}

/** Whether findings under this lens carry a me/them lane. A meeting record has
 *  no opposing side — everyone present is on the same one. */
export function hasSides(lens: AnalysisLens): boolean {
  return lens !== "decision";
}

/** Whether findings under this lens carry resolved/resolution ("ME defused
 *  it"). Only the adversarial lens: in a sales call "I rebutted the customer"
 *  is a bad thing to optimize, and in a team meeting it is meaningless. */
export function hasResolution(lens: AnalysisLens): boolean {
  return lens === "adversarial";
}

/** Whether findings under this lens are bucketed 決議 / 未解 / 事實. */
export function hasCategories(lens: AnalysisLens): boolean {
  return lens === "decision";
}

/** The finding buckets of the decision lens — a meeting record's whole point is
 *  telling "we decided X" apart from "X is still open" apart from "X is just so". */
export const DECISION_CATEGORIES = ["decision", "open", "fact"] as const;

// ── Prompt frames (model input — English on purpose, like every other prompt) ──

/** How the timeline pass introduces itself under each lens. */
export function findingsIntro(lens: AnalysisLens, mode: "live" | "replay"): string {
  const tense =
    mode === "live"
      ? "The meeting is STILL IN PROGRESS — you see only what has been said SO FAR."
      : "The conversation is OVER and you can see the whole thing.";
  if (lens === "decision")
    return `You are writing the RECORD of a working meeting — an internal team discussion, design review, planning session, or project sync — for the user ("ME"), who was in the room. ${tense} Everyone present is on the SAME side; there is no opposing party and nothing to win. Your job is to capture what the meeting PRODUCED: what got decided, what is still open, and the facts established along the way.`;
  if (lens === "opportunity")
    return `You are analyzing a SALES conversation for the user ("ME") with a prospect or customer ("THEM"). ${tense} This is not a fight to win — a customer objection is information, not an attack. Your job is to surface what moves the opportunity: the pain THEM revealed, the objections and risks THEM raised, and what ME still does not know.`;
  return `You are doing a post-hoc RETRO of a finished negotiation for the user ("ME") against the other party ("THEM"). ${tense}`;
}

/** The per-lens field guide spliced into the timeline pass's field list. */
export function findingsFieldGuide(lens: AnalysisLens): string {
  if (lens === "decision")
    return `- category: "decision" when the meeting SETTLED something (a choice made, an approach agreed, a thing explicitly dropped) — this is the most valuable output, do not bury a real decision as a mere fact; "open" when a question was raised and left UNRESOLVED, or a decision was explicitly deferred; "fact" for a substantive piece of information established or explained that is neither.
- title: a short label for what was decided / left open / established.
- detail: ONE or two sentences carrying the substance — for a decision, WHAT was decided and, when it was argued, the reason that won; for an open item, what specifically is still undecided and what it is blocked on.
Do NOT judge how well ME performed, do NOT score anyone, and do NOT write coaching advice. This is a record, not a review.`;
  if (lens === "opportunity")
    return `- side: "them" for something THEM revealed or raised (a pain, a requirement, an objection, a constraint, a buying signal, a competitor); "me" for a gap on MY side — a question ME failed to ask, a qualification dimension still unknown, a commitment ME made loosely.
- title: a short label for the moment.
- detail: 1-2 sentences on what it means for the opportunity — what the pain really is, what is behind the objection, or what ME still needs to learn.
Do NOT frame THEM as an adversary and do NOT score ME on "winning" an exchange. An objection ME answered is still worth recording as the objection it was.`;
  return `- side: "them" for a substantive move BY THEM (a position, argument, demand, anchor, pressure, leverage, or a constraint/concern they raised); "me" for a problem/mistake/missed move BY ME.
- title: a short label for the dynamic (not a quote).
- detail: 1-2 sentences on the STRATEGIC substance — the underlying interest, leverage, risk, missed exploration, or move — and why it matters.`;
}

/**
 * The brief's section spec. Headings are English here (model input); the
 * output-language instruction translates them along with the prose, exactly as
 * the adversarial brief has always worked.
 */
export function briefSections(lens: AnalysisLens): string {
  if (lens === "decision")
    return `## Highlights
3-5 bullets covering what this meeting was actually about and what came out of it. No praise, no scoring.

## Decisions
Every decision the meeting settled — one bullet each, stating what was decided. End each bullet with the [m:ss] where it was settled. If the meeting settled nothing, say so in one line rather than inventing decisions.

## Open questions
What was raised and left unresolved, and what each one is waiting on. End each bullet with its [m:ss].

## Suggested next agenda
2-4 bullets: what the next session of this meeting should open with, based on what was left open.

Write a RECORD, not a review. Do NOT assess how ME performed, do NOT list what fell short, and do NOT give coaching advice — none of that belongs in meeting notes.`;
  if (lens === "opportunity")
    return `## Where this landed
How the opportunity stands after this call, in a few lines.

## Their pain and objections
What THEM actually needs, and every concern or objection they raised — each with a [m:ss].

## What we still don't know
The qualification gaps that matter: unknown budget, decision process, timeline, competing options, who actually decides. Be specific about the question that would close each gap.

## Next steps
What ME should do to advance this deal, concretely.`;
  return `## Outcome
How it went overall and whether ME achieved the goal.

## What fell short
Objectives or evaluation criteria that were NOT met — each with a one-line piece of evidence from the transcript.

## How to improve
Concrete, specific things ME could do better next time. No generic advice.

## Key moments
2-4 pivotal points. Start each bullet with the moment's timestamp in [m:ss] form (copy it from the transcript line), then: what happened, then the counterfactual — "when X happened, if ME had done Y, THEM could not have Z."`;
}

/** How the brief pass introduces itself under each lens. */
export function briefIntro(lens: AnalysisLens): string {
  if (lens === "decision")
    return `You are writing the MEETING NOTES for a finished internal working meeting, for ME, who was in the room. Everyone present was on the same side. The meeting is OVER and you can see the full transcript.`;
  if (lens === "opportunity")
    return `You are writing the POST-CALL summary of a finished SALES conversation for ME. The call is OVER and you can see the full transcript, so judge the whole conversation, not the moment.`;
  return `You are writing a POST-MEETING debrief for ME after a live negotiation. The meeting is OVER and you can see the full transcript, so judge the whole conversation, not the moment.`;
}

/** How the action-items pass introduces itself under each lens. */
export function actionsIntro(lens: AnalysisLens): string {
  if (lens === "decision")
    return `You are writing the FOLLOW-UPS from a finished internal working meeting, for ME. The meeting is OVER. These are the things the meeting agreed someone would go do, plus anything left open that needs chasing.`;
  if (lens === "opportunity")
    return `You are writing the POST-CALL next steps after a finished sales conversation, for ME. The call is OVER.`;
  return `You are writing the POST-MEETING ACTION ITEMS for the user ("ME") after a finished negotiation against the other party ("THEM"). The meeting is OVER.`;
}
