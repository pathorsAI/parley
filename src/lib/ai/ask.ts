import { streamText } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { transcriptAsText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import { log } from "../log";
import type { Settings, TranscriptSegment } from "../types";

const SYSTEM = `You are Parley, a realtime meeting copilot assisting the user ("ME") during a live interview or negotiation against the other party ("THEM").

You are given the running transcript so far, labelled by speaker. Answer the user's question grounded strictly in what was actually said. Be concise and direct — the user is mid-meeting and skimming. If the transcript doesn't contain the answer, say so plainly rather than speculating. When useful, suggest a concrete next move (a question to ask, a point to push back on).`;

/**
 * Stream an answer to a question about the live meeting. `onDelta` is called
 * with each text chunk, `onReasoningDelta` with each reasoning chunk from
 * reasoning-capable models; the promise resolves with the full answer.
 */
export async function askAboutMeeting(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  question: string;
  meetingContext?: string;
  names?: Record<string, string>;
  onDelta: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, segments, question, meetingContext, names, onDelta, onReasoningDelta, signal } =
    opts;

  const transcript = transcriptAsText(segments, names) || "(no speech transcribed yet)";
  const contextLine =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  const provider = settings.provider;
  const model = settings.models[settings.provider].ask;
  log.info("ai.ask: start", {
    provider,
    model,
    segments: segments.length,
    questionChars: question.length,
  });

  let full = "";
  try {
    const result = streamText({
      model: getModel(settings, "ask"),
      providerOptions: getProviderOptions(settings, "ask"),
      system: SYSTEM,
      abortSignal: signal,
      prompt: `${contextLine}Transcript so far:\n${transcript}\n\nQuestion: ${question}`,
    });

    // fullStream surfaces errors as parts instead of throwing — re-throw them
    // so callers keep a single error path.
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        full += part.text;
        onDelta(part.text);
      } else if (part.type === "reasoning-delta") {
        onReasoningDelta?.(part.text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    // Usage resolves once the stream finishes; log it without blocking the return.
    void (async () => {
      try {
        await recordLlmUsage(settings, "ask", "ask", await result.usage);
      } catch {
        /* best-effort logging */
      }
    })();
  } catch (e) {
    log.error("ai.ask: failed", { provider, model, error: String(e) });
    throw e;
  }
  log.info("ai.ask: ok", { chars: full.length });
  return full;
}
