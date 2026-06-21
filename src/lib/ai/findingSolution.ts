import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { formatClock, transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import type { FindingSolution, Settings, TimelineEvent, TranscriptSegment } from "../types";

const moveSchema = z.object({
  kind: z
    .enum(["rebut", "reframe", "trade", "concede_redirect"])
    .describe(
      "rebut = attack the logic head-on; reframe = refuse/reframe a smuggled premise; " +
        "trade = don't argue the logic, use negotiation leverage instead; " +
        "concede_redirect = grant the small point, then pivot to what matters."
    ),
  approach: z
    .string()
    .describe("A concrete move ME should have made — phrased as something ME could actually say or do."),
  why: z.string().describe("One sentence on why this is the better move."),
  predictedReaction: z
    .string()
    .describe("Realistic prediction of how a tough, self-interested THEM would react to this move."),
});

// Strict json_schema: every property must be present in `required`, so use
// `.nullable()` (not `.optional()`). Downstream code is null-safe.
const schema = z.object({
  summary: z
    .string()
    .describe("One line: what went wrong (ME) or what THEM did, and what ME should do instead."),
  moves: z.array(moveSchema).describe("1-3 concrete corrective moves, spanning kinds where sensible."),
  suggestedLine: z
    .string()
    .nullable()
    .describe('For an ME-side mistake, a VERBATIM line ME could have said instead; null if not applicable.'),
});

const SYSTEM = `You are the coaching engine for Parley. The user ("ME") is in a negotiation/interview against the other party ("THEM"). You are given ONE notable moment from the conversation plus the surrounding transcript. Show ME how it should have been handled.

- If the moment is a MISTAKE / MISSED MOVE BY ME (side = "me"): explain what ME should have said or done instead, and provide a VERBATIM "suggestedLine" ME could have used at that moment.
- If the moment is an ARGUMENT / PRESSURE / CLAIM BY THEM (side = "them"): show ME how to counter it. Set "suggestedLine" to null unless a specific verbatim reply is clearly the strongest move.

For each move give a concrete "approach" (something ME could actually say/do), a one-sentence "why", and a realistic "predictedReaction" from a tough, self-interested THEM. Offer 1-3 moves spanning the angles where sensible (rebut / reframe / trade / concede_redirect) — don't force kinds that don't fit. Ground everything in what was actually said; never invent quotes. Respond ENTIRELY in the language of the transcript.`;

/** Window (ms) of transcript on each side of the finding to hand the model. */
const WINDOW_MS = 60_000;

/**
 * Generate the "how it should have been done" solution for ONE finding. Reads a
 * window of transcript around the moment (full transcript fallback) plus the
 * finding fields, and branches the framing on `finding.side`. Mode-agnostic:
 * works for LIVE (transcript so far) and REPLAY (whole recording) alike.
 */
export async function generateFindingSolution(opts: {
  settings: Settings;
  finding: TimelineEvent;
  segments: TranscriptSegment[];
  meetingContext?: string;
  names?: Record<string, string>;
}): Promise<FindingSolution> {
  const { settings, finding, segments, meetingContext, names } = opts;

  const near = segments.filter(
    (s) => s.endMs >= finding.atMs - WINDOW_MS && s.startMs <= finding.atMs + WINDOW_MS
  );
  const windowed = transcriptWithTimestamps(near.length ? near : segments, names);

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  const moment =
    `The moment (at ${formatClock(finding.atMs)}, side = ${finding.side}):\n` +
    `- ${finding.title}: ${finding.detail}` +
    (finding.quote ? `\n- Quote: "${finding.quote}"` : "");

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}${moment}\n\nSurrounding transcript:\n${windowed || "(no transcript)"}\n\nShow ME how this should have been handled.`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  return {
    findingId: finding.id,
    summary: object.summary,
    moves: (object.moves ?? []).map((m) => ({
      kind: m.kind,
      approach: m.approach,
      why: m.why,
      predictedReaction: m.predictedReaction,
    })),
    suggestedLine: object.suggestedLine?.trim() ? object.suggestedLine.trim() : null,
  };
}
