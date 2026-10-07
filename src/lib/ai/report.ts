import { generateText, streamText, type FinishReason, type LanguageModelUsage } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { maxOutputTokensFor } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { briefIntro, briefSections } from "../analysis/lens";
import { log } from "../log";
import { fillPrompt, meetingContextBlock, STUDY } from "./studyPrompt";
import type { AnalysisLens, Evaluation, Settings, TodoItem, TranscriptSegment } from "../types";

/**
 * The brief's system prompt for one lens. The SECTIONS are the lens's whole
 * point: meeting notes get 決議 / 未解 / 下次議程, a sales call gets pain and
 * qualification gaps, and only a real negotiation gets "what fell short" — which
 * used to be written for every recording regardless of what it was. Text:
 * shared/prompts/study.json (`brief.*`).
 */
function systemFor(lens: AnalysisLens): string {
  return fillPrompt(STUDY.brief.systemTemplate, { intro: briefIntro(lens), sections: briefSections(lens) });
}

/** Usage fields worth logging when a brief comes back empty — never content. */
function usageFields(usage: LanguageModelUsage | undefined) {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
  };
}

/** A stream promise that may reject (no step was produced at all) → undefined. */
async function settledOrUndefined<T>(p: PromiseLike<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

function recordUsage(settings: Settings, usage: LanguageModelUsage | undefined): void {
  void recordLlmUsage(settings, "deep", "report", usage).catch(() => {
    /* best-effort usage logging */
  });
}

/**
 * Stream the brief through `onDelta` and return its full text.
 *
 * An EMPTY brief is an error, never a result. AI SDK `streamText` does not throw
 * a stream error out of `textStream` — it hands it to `onError` and the stream
 * simply ends — and a reasoning model (Groq gpt-oss) can spend its whole budget
 * thinking and emit no text at all. Either way the loop used to finish with ""
 * and the caller saved that as the brief, which reads as "never generated" on
 * the next open, so the brief regenerated on every open. Now: an empty stream
 * is logged with its finish reason + usage and retried ONCE non-streamed; if
 * that is empty too, this throws. A stream that errored after some text throws
 * as well, rather than passing a truncated brief off as complete.
 */
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
  const B = STUDY.brief;
  const rubric = evaluations.map((e) => fillPrompt(B.rubricEntry, { name: e.name, prompt: e.prompt })).join("\n");
  const checklist = todos
    .map((t) => fillPrompt(B.checklistEntry, { mark: t.done ? "x" : " ", text: t.text }))
    .join("\n");

  const prompt =
    profileContext(settings) +
    meetingContextBlock(meetingContext) +
    (rubric ? `${B.rubricHeader}\n${rubric}\n\n` : "") +
    (checklist ? `${B.checklistHeader}\n${checklist}\n\n` : "") +
    `${B.transcriptHeader}\n${transcript || STUDY.noSpeech}`;

  const provider = settings.llmProviders.deep;
  const model = settings.models[provider].deep;
  log.info("ai.report: start", { provider, model, lens, segments: segments.length });

  const call = {
    model: getModel(settings, "deep"),
    providerOptions: getProviderOptions(settings, "deep"),
    system: systemFor(lens) + outputLanguageInstruction(settings),
    abortSignal: signal,
    prompt,
    // Reasoning models spend output tokens on hidden reasoning first; without
    // headroom they exhaust the budget before writing a word of the brief.
    maxOutputTokens: maxOutputTokensFor(settings, "deep"),
  };

  let full = "";
  try {
    let streamError: unknown = null;
    const result = streamText({
      ...call,
      onError: ({ error }) => {
        streamError = error;
      },
    });
    for await (const delta of result.textStream) {
      full += delta;
      onDelta(delta);
    }
    const finishReason: FinishReason | undefined = await settledOrUndefined(result.finishReason);
    const usage = await settledOrUndefined(result.usage);
    recordUsage(settings, usage);

    if (streamError && full.trim()) {
      log.warn("ai.report: stream failed mid-brief", { provider, model, chars: full.length, finishReason });
      throw streamError;
    }
    if (!full.trim()) {
      log.warn("ai.report: empty stream, retrying non-streamed", {
        provider,
        model,
        finishReason,
        ...usageFields(usage),
        error: describeStreamError(streamError),
      });
      const res = await generateText(call);
      recordUsage(settings, res.usage);
      if (!res.text.trim()) {
        log.error("ai.report: empty again after retry", {
          provider,
          model,
          finishReason: res.finishReason,
          ...usageFields(res.usage),
        });
        throw new Error(`The model returned no brief text (finish reason: ${res.finishReason})`);
      }
      full = res.text;
      onDelta(full);
      log.info("ai.report: recovered non-streamed", { finishReason: res.finishReason });
    } else if (finishReason === "length") {
      log.warn("ai.report: brief hit the output-token cap", { provider, model, chars: full.length });
    }
  } catch (e) {
    log.error("ai.report: failed", { provider, model, error: String(e) });
    throw e;
  }
  log.info("ai.report: ok", { chars: full.length });
  return full;
}

/** A stream error for the log line: its message when it is an Error, else JSON. */
function describeStreamError(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "unserializable stream error";
  }
}
