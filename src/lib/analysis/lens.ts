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
import { fillPrompt, STUDY } from "../ai/studyPrompt";
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
// The text lives in shared/prompts/study.json (shared with Android); these
// accessors only pick the right fragment for a lens.

/** How the timeline pass introduces itself under each lens. */
export function findingsIntro(lens: AnalysisLens, mode: "live" | "replay"): string {
  return fillPrompt(STUDY.timeline.intro[lens], { tense: STUDY.timeline.tense[mode] });
}

/** The per-lens field guide spliced into the timeline pass's field list. */
export function findingsFieldGuide(lens: AnalysisLens): string {
  return STUDY.timeline.fieldGuide[lens];
}

/**
 * The brief's section spec. Headings are English (model input); the
 * output-language instruction translates them along with the prose, exactly as
 * the adversarial brief has always worked.
 */
export function briefSections(lens: AnalysisLens): string {
  return STUDY.brief.sections[lens];
}

/** How the brief pass introduces itself under each lens. */
export function briefIntro(lens: AnalysisLens): string {
  return STUDY.brief.intro[lens];
}

/** How the action-items pass introduces itself under each lens. */
export function actionsIntro(lens: AnalysisLens): string {
  return STUDY.actionItems.intro[lens];
}
