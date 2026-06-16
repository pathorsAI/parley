import { streamText } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { transcriptAsText } from "../store";
import type { Settings, TranscriptSegment } from "../types";

const SYSTEM = `You are Parley, a realtime meeting copilot assisting the user ("ME") during a live interview or negotiation against the other party ("THEM").

You are given the running transcript so far, labelled by speaker. Answer the user's question grounded strictly in what was actually said. Be concise and direct — the user is mid-meeting and skimming. If the transcript doesn't contain the answer, say so plainly rather than speculating. When useful, suggest a concrete next move (a question to ask, a point to push back on).`;

/**
 * Stream an answer to a question about the live meeting. `onDelta` is called
 * with each text chunk; the promise resolves with the full answer.
 */
export async function askAboutMeeting(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  question: string;
  meetingContext?: string;
  names?: Record<string, string>;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, segments, question, meetingContext, names, onDelta, signal } = opts;

  const transcript = transcriptAsText(segments, names) || "(no speech transcribed yet)";
  const contextLine = meetingContext?.trim()
    ? `Meeting context: ${meetingContext.trim()}\n\n`
    : "";

  const result = streamText({
    model: getModel(settings, "ask"),
    providerOptions: getProviderOptions(settings, "ask"),
    system: SYSTEM,
    abortSignal: signal,
    prompt: `${contextLine}Transcript so far:\n${transcript}\n\nQuestion: ${question}`,
  });

  let full = "";
  for await (const delta of result.textStream) {
    full += delta;
    onDelta(delta);
  }
  return full;
}
