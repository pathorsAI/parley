import { streamText } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { log } from "../log";
import type { Evaluation, Settings, TodoItem, TranscriptSegment } from "../types";

const SYSTEM = `You are writing a POST-MEETING debrief for ME after a live interview, negotiation, sales, or diligence call. The meeting is OVER and you can see the full transcript, so judge the whole conversation, not the moment.

Write a concise, candid debrief in Markdown with exactly these sections:

## Outcome
How it went overall and whether ME achieved the goal.

## What fell short
Objectives or evaluation criteria that were NOT met — each with a one-line piece of evidence from the transcript.

## How to improve
Concrete, specific things ME could do better next time. No generic advice.

## Key moments
2–4 pivotal points. Start each bullet with the moment's timestamp in [m:ss] form (copy it from the transcript line), then: what happened, then the counterfactual — "when X happened, if ME had done Y, THEM could not have Z."

Each transcript line is prefixed with its [m:ss] start time. Cite those timestamps verbatim whenever you point at a specific moment so the reader can jump back to it. Ground everything in what was actually said. Skip filler and praise that isn't earned. If the transcript is too short to assess, say so plainly.`;

export async function generatePostMeetingReport(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  evaluations: Evaluation[];
  todos: TodoItem[];
  names?: Record<string, string>;
  meetingContext?: string;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, segments, evaluations, todos, names, meetingContext, onDelta, signal } = opts;

  const transcript = transcriptWithTimestamps(segments, names);
  const rubric = evaluations.map((e) => `- ${e.name}: ${e.prompt}`).join("\n");
  const checklist = todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n");
  const ctxLine = meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "";

  const prompt =
    profileContext(settings) +
    ctxLine +
    (rubric ? `What mattered in this meeting (evaluation rubric):\n${rubric}\n\n` : "") +
    (checklist ? `Agenda / checklist:\n${checklist}\n\n` : "") +
    `Full transcript:\n${transcript || "(no speech was captured)"}`;

  const provider = settings.llmProviders.deep;
  const model = settings.models[provider].deep;
  log.info("ai.report: start", { provider, model, segments: segments.length });

  let full = "";
  try {
    const result = streamText({
      model: getModel(settings, "deep"),
      providerOptions: getProviderOptions(settings, "deep"),
      system: SYSTEM + outputLanguageInstruction(settings),
      abortSignal: signal,
      prompt,
    });

    for await (const delta of result.textStream) {
      full += delta;
      onDelta(delta);
    }
    void (async () => {
      try {
        await recordLlmUsage(settings, "deep", "report", await result.usage);
      } catch {
        /* best-effort usage logging */
      }
    })();
  } catch (e) {
    log.error("ai.report: failed", { provider, model, error: String(e) });
    throw e;
  }
  log.info("ai.report: ok", { chars: full.length });
  return full;
}
