import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./provider";
import { transcriptAsText } from "../store";
import type { Evaluation, EvalResult, Settings, TranscriptSegment } from "../types";

// Structured output contract shared by every evaluation. Mirrors EvalResult.
const evalSchema = z.object({
  flagged: z
    .boolean()
    .describe("True only if the situation is worth surfacing to the user right now."),
  severity: z.enum(["info", "warn", "critical"]),
  summary: z.string().describe("One or two sentences the user can read at a glance."),
  evidence: z
    .array(
      z.object({
        quote: z.string().describe("The exact words from the transcript."),
        source: z.enum(["me", "them"]),
        reason: z.string().describe("Why this quote matters for the finding."),
      })
    )
    .describe("Supporting quotes. Empty when nothing is flagged."),
});

const SYSTEM = `You are an evaluation engine for Parley, a realtime meeting copilot. You monitor a live interview or negotiation transcript on behalf of the user ("ME"), watching the other party ("THEM").

You will be given one specific thing to watch for, plus the transcript so far. Judge ONLY against what was actually said — never invent quotes or infer beyond the text. Flag only when you have concrete evidence; a clean transcript should return flagged=false with empty evidence. Keep the summary short and actionable.`;

/**
 * Run a single evaluation over the current transcript and return its structured
 * result. Uses the stronger "eval" model via the active provider.
 */
export async function runEvaluation(opts: {
  settings: Settings;
  evaluation: Evaluation;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
}): Promise<EvalResult> {
  const { settings, evaluation, segments, names } = opts;
  const transcript = transcriptAsText(segments, names);

  const contextLine = settings.meetingContext.trim()
    ? `Meeting context: ${settings.meetingContext.trim()}\n\n`
    : "";

  const { object } = await generateObject({
    model: getModel(settings, "eval"),
    schema: evalSchema,
    system: SYSTEM,
    prompt: `${contextLine}What to watch for: ${evaluation.prompt}\n\nTranscript so far:\n${transcript}`,
  });

  return object;
}
