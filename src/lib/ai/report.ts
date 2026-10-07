import { generateText, streamText, type FinishReason, type LanguageModelUsage } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { maxOutputTokensFor } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { briefIntro, briefSections } from "../analysis/lens";
import { log } from "../log";
import {
  createDeadline,
  rejectOnAbort,
  STUDY_FALLBACK_DEADLINE_MS,
  STUDY_HARD_DEADLINE_MS,
  STUDY_STALL_MS,
  untilAborted,
  type Deadline,
} from "./deadline";
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

function timedOut(deadline: Deadline): boolean {
  const why = deadline.reason();
  return why === "hard" || why === "stall";
}

/** The deadline's timeout error when it fired, else the original error. */
function deadlineError(err: unknown, deadline: Deadline): unknown {
  return timedOut(deadline) ? deadline.signal.reason : err;
}

/**
 * The ONE non-streamed retry after an empty (or timed-out, empty) stream, under
 * its own fresh ceiling. Throws when it comes back empty too.
 */
async function generateBriefOnce(
  call: Omit<Parameters<typeof generateText>[0], "abortSignal">,
  settings: Settings,
  signal: AbortSignal | undefined,
): Promise<string> {
  const deadline = createDeadline({ hardMs: STUDY_FALLBACK_DEADLINE_MS, parent: signal });
  try {
    const res = await Promise.race([
      generateText({ ...call, abortSignal: deadline.signal } as Parameters<typeof generateText>[0]),
      rejectOnAbort(deadline.signal),
    ]);
    recordUsage(settings, res.usage);
    if (!res.text.trim()) {
      log.error("ai.report: empty again after retry", { finishReason: res.finishReason, ...usageFields(res.usage) });
      throw new Error(`The model returned no brief text (finish reason: ${res.finishReason})`);
    }
    log.info("ai.report: recovered non-streamed", { finishReason: res.finishReason });
    return res.text;
  } catch (e) {
    throw deadlineError(e, deadline);
  } finally {
    deadline.clear();
  }
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
 *
 * Bounded in time: the stream runs under a 4-minute ceiling and a 90-second
 * stall timer (ai/deadline.ts), the non-streamed retry under its own 2-minute
 * one, and `signal` cancels both. A stream that times out before writing a word
 * gets the retry; one that times out mid-brief throws the timeout.
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

  // Bounded like every study pass (ai/deadline.ts): a hard ceiling, plus a
  // stall timer every streamed chunk resets. `signal` (the run) is the parent,
  // so a cancelled run aborts the request instead of letting it finish unseen.
  const deadline = createDeadline({ hardMs: STUDY_HARD_DEADLINE_MS, stallMs: STUDY_STALL_MS, parent: signal });
  const call = {
    model: getModel(settings, "deep"),
    providerOptions: getProviderOptions(settings, "deep"),
    system: systemFor(lens) + outputLanguageInstruction(settings),
    prompt,
    // Reasoning models spend output tokens on hidden reasoning first; without
    // headroom they exhaust the budget before writing a word of the brief.
    maxOutputTokens: maxOutputTokensFor(settings, "deep"),
  };

  let full = "";
  try {
    let streamError: unknown = null;
    let finishReason: FinishReason | undefined;
    let usage: LanguageModelUsage | undefined;
    try {
      const result = streamText({
        ...call,
        abortSignal: deadline.signal,
        onError: ({ error }) => {
          streamError = error;
        },
      });
      for await (const delta of untilAborted(result.textStream, deadline.signal)) {
        deadline.touch();
        full += delta;
        onDelta(delta);
      }
      // An abort can also just END the text stream; that is not a finished brief.
      deadline.signal.throwIfAborted();
      finishReason = await settledOrUndefined(result.finishReason);
      usage = await settledOrUndefined(result.usage);
      recordUsage(settings, usage);
    } catch (e) {
      // Only our own deadline with NOTHING written falls through to the
      // non-streamed retry below; a cancellation, or a timeout after part of the
      // brief streamed, is a failure (a truncated brief is not a brief).
      if (!timedOut(deadline) || full.trim()) throw deadlineError(e, deadline);
      streamError = deadline.signal.reason;
    }

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
      full = await generateBriefOnce(call, settings, signal);
      onDelta(full);
    } else if (finishReason === "length") {
      log.warn("ai.report: brief hit the output-token cap", { provider, model, chars: full.length });
    }
  } catch (e) {
    log.error("ai.report: failed", { provider, model, error: String(e) });
    throw e;
  } finally {
    deadline.clear();
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
