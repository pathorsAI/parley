import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { transcriptAsText, useStore } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { EvalDef, EvalResult, Settings, TranscriptSegment } from "../types";

// One result per evaluation, returned together from a single model call.
const resultSchema = z.object({
  id: z.string().describe("The evaluation id this result is for."),
  flagged: z.boolean().describe("True only if worth surfacing to the user right now."),
  severity: z.enum(["info", "warn", "critical"]),
  summary: z.string().describe("One or two sentences the user can read at a glance."),
  evidence: z
    .array(
      z.object({
        quote: z.string(),
        source: z.enum(["me", "them"]),
        reason: z.string(),
      })
    )
    .describe("Supporting quotes; empty when not flagged."),
});
const batchSchema = z.object({ results: z.array(resultSchema) });

const SYSTEM = `You are the evaluation engine for Parley, a realtime meeting copilot. You monitor a live interview/negotiation transcript on behalf of the user ("ME"), watching the other party ("THEM").

You are given SEVERAL evaluations at once, each with an id and what to look for. Run them ALL against the transcript and return exactly one result per id. Judge only against what was actually said — never invent quotes. Flag only with concrete evidence; an evaluation with nothing to report returns flagged=false and empty evidence. Keep summaries short and actionable.`;

/**
 * Run every evaluation in a SINGLE model call and return results keyed by id.
 * Cheaper and more coherent than one request per evaluation.
 */
export async function runAllEvaluations(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  evals: EvalDef[];
  names?: Record<string, string>;
}): Promise<Record<string, EvalResult>> {
  const { settings, segments, evals, names } = opts;
  const transcript = transcriptAsText(segments, names);
  const meetingContext = useStore.getState().meetingContext;
  const ctx =
    profileContext(settings) + (meetingContext.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");
  const list = evals
    .map((e) => `### id: ${e.id}\nname: ${e.name}\nwatch for: ${e.prompt}`)
    .join("\n\n");

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema: batchSchema,
    system: SYSTEM + JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Evaluations (return one result per id):\n${list}\n\nTranscript so far:\n${transcript}`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  const map: Record<string, EvalResult> = {};
  for (const r of object.results) {
    map[r.id] = { flagged: r.flagged, severity: r.severity, summary: r.summary, evidence: r.evidence };
  }
  return map;
}
