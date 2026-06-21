import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { formatClock, transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import type { FindingSolution, Settings, TimelineEvent, TranscriptSegment } from "../types";

const replySchema = z.object({
  kind: z
    .enum(["rebut", "reframe", "trade", "concede_redirect"])
    .describe(
      "rebut = attack the logic head-on; reframe = refuse/reframe a smuggled premise; " +
        "trade = don't argue the logic, use negotiation leverage instead; " +
        "concede_redirect = grant the small point, then pivot to what matters."
    ),
  reply: z
    .string()
    .describe(
      "A VERBATIM line MY SIDE (ME) says next at this moment — MY words, ready to use, no stage directions. NEVER a line THEM would say."
    ),
  consideration: z
    .string()
    .describe(
      "ONE short line: the key trade-off, or what this reply does for ME's position in the OVERALL negotiation."
    ),
});

const schema = z.object({
  replies: z
    .array(replySchema)
    .describe("2-3 distinct ready-to-use reply options, spanning angles (rebut/reframe/trade/concede_redirect) where sensible."),
});

const SYSTEM = `You are the reply coach for Parley. The user ("ME") is in a negotiation/interview against the other party ("THEM"). You are given ONE notable moment plus the FULL conversation transcript.

WHOSE REPLY — CRITICAL: every "reply" is the next line MY SIDE ("ME") says, in MY voice and serving MY interest. You are coaching ME, NOT THEM — NEVER write what THEM would say, and NEVER continue, defend, or strengthen THEM's argument. The self-profile and meeting context tell you which speaker is ME; everyone else is THEM. If the moment's side is "them", ME is RESPONDING TO / countering what THEM did there; if the side is "me", ME is fixing MY OWN misstep — what ME should have said instead. If it's ever unclear who is who, infer ME from the profile + meeting context (and which side each speaker argues for) and ALWAYS reply from MY side.

Think about the WHOLE negotiation — the overall stakes, leverage, and where the deal is heading — not just this one local exchange. A reply that wins this point but weakens ME's position in the bigger picture is a bad reply. Then hand ME ready-to-use ways to reply at this moment.

Ground the replies in PRINCIPLED NEGOTIATION: focus on INTERESTS not positions, appeal to OBJECTIVE CRITERIA rather than raw pressure, look for OPTIONS that create mutual gain, and account for MY BATNA / target / bottom line (given in the context, if any) and the ZOPA. Never invent facts, numbers, or a BATNA that wasn't given.

Output ONLY:
- 2-3 distinct "reply" options, each a VERBATIM line ME can say right now. Span different strategic angles where it helps (rebut / reframe / trade / concede_redirect) — don't force angles that don't fit.
- For each, ONE short "consideration": the key trade-off, or what the reply does for ME's position in the overall negotiation.

Be terse. Do NOT explain at length what went wrong, summarize, or narrate the situation — ME already knows the moment. Ground every reply in what was actually said across the whole transcript; never invent quotes or facts. Respond ENTIRELY in the language of the transcript.`;

/**
 * Generate the "how should I reply" solution for ONE finding. Reads the FULL
 * transcript (global — the model weighs the whole negotiation, not just the
 * local exchange) plus the finding fields. Mode-agnostic: works for LIVE
 * (transcript so far) and REPLAY (whole recording) alike.
 */
export async function generateFindingSolution(opts: {
  settings: Settings;
  finding: TimelineEvent;
  segments: TranscriptSegment[];
  meetingContext?: string;
  names?: Record<string, string>;
}): Promise<FindingSolution> {
  const { settings, finding, segments, meetingContext, names } = opts;

  // Global: hand the model the entire conversation so its reply accounts for the
  // whole negotiation, not just a 1-2 minute window around the moment.
  const fullTranscript = transcriptWithTimestamps(segments, names);

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  const quotes = finding.quotes ?? [];
  const moment =
    `The moment to reply to (at ${formatClock(finding.atMs)}, side = ${finding.side}):\n` +
    `- ${finding.title}: ${finding.detail}` +
    (quotes.length ? `\n- Quote(s):\n${quotes.map((q) => `  - "${q}"`).join("\n")}` : "");

  const { object, usage } = await generateObjectResilient({
    settings,
    kind: "eval",
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}${moment}\n\nFull transcript:\n${fullTranscript || "(no transcript)"}\n\nWeigh the whole negotiation, then give ME the reply options — each a line MY side would say next, never THEM's.`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  return {
    findingId: finding.id,
    replies: (object.replies ?? []).map((r) => ({
      kind: r.kind,
      reply: r.reply,
      consideration: r.consideration,
    })),
  };
}
