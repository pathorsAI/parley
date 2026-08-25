import { streamText } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { briefIntro, briefSections } from "../analysis/lens";
import { log } from "../log";
import type { AnalysisLens, Evaluation, Settings, TodoItem, TranscriptSegment } from "../types";

/**
 * The brief's system prompt for one lens. The SECTIONS are the lens's whole
 * point: meeting notes get 決議 / 未解 / 下次議程, a sales call gets pain and
 * qualification gaps, and only a real negotiation gets "what fell short" — which
 * used to be written for every recording regardless of what it was.
 */
function systemFor(lens: AnalysisLens): string {
  return `${briefIntro(lens)}

Write it in Markdown with exactly these sections:

${briefSections(lens)}

Each transcript line is prefixed with its [m:ss] start time. Cite those timestamps verbatim whenever you point at a specific moment so the reader can jump back to it. Ground everything in what was actually said. Skip filler and praise that isn't earned. If the transcript is too short to assess, say so plainly.`;
}

export async function generatePostMeetingReport(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  evaluations: Evaluation[];
  todos: TodoItem[];
  names?: Record<string, string>;
  meetingContext?: string;
  /** Which sections to write. Defaults to plain meeting notes. */
  lens?: AnalysisLens;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, segments, evaluations, todos, names, meetingContext, lens = "decision", onDelta, signal } = opts;

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
  log.info("ai.report: start", { provider, model, lens, segments: segments.length });

  let full = "";
  try {
    const result = streamText({
      model: getModel(settings, "deep"),
      providerOptions: getProviderOptions(settings, "deep"),
      system: systemFor(lens) + outputLanguageInstruction(settings),
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
