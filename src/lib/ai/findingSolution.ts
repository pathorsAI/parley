import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { formatClock, transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import type { FindingSolution, Settings, TimelineEvent, TranscriptSegment } from "../types";

export type FindingSolutionMode = "live" | "replay";

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

const SYSTEM = `You are the reply coach for Parley. The user ("ME") is in a negotiation/interview against the other party ("THEM"). You are given ONE notable moment plus timestamped transcript context.

WHOSE REPLY — CRITICAL: every "reply" is the next line MY SIDE ("ME") says, in MY voice and serving MY interest. You are coaching ME, NOT THEM — NEVER write what THEM would say, and NEVER continue, defend, or strengthen THEM's argument. The self-profile and meeting context tell you which speaker is ME; everyone else is THEM. If the moment's side is "them", ME is RESPONDING TO / countering what THEM did there; if the side is "me", ME is fixing MY OWN misstep — what ME should have said instead. If it's ever unclear who is who, infer ME from the profile + meeting context (and which side each speaker argues for) and ALWAYS reply from MY side.

Think about the overall stakes, leverage, and where the deal is heading — not just this one local exchange. A reply that wins this point but weakens ME's position in the bigger picture is a bad reply. Then hand ME ready-to-use ways to reply at this moment.

Ground the replies in PRINCIPLED NEGOTIATION: focus on INTERESTS not positions, appeal to OBJECTIVE CRITERIA rather than raw pressure, look for OPTIONS that create mutual gain, and account for MY BATNA / target / bottom line (given in the context, if any) and the ZOPA. Never invent facts, numbers, or a BATNA that wasn't given.

Output ONLY:
- 2-3 distinct "reply" options, each a VERBATIM line ME can say right now. Span different strategic angles where it helps (rebut / reframe / trade / concede_redirect) — don't force angles that don't fit.
- For each, ONE short "consideration": the key trade-off, or what the reply does for ME's position in the overall negotiation.

Be terse. Do NOT explain at length what went wrong, summarize, or narrate the situation — ME already knows the moment. Ground every reply in what was actually knowable at the moment unless a section is explicitly labeled HINDSIGHT; never invent quotes or facts. Respond ENTIRELY in the language of the transcript.`;

function findingCutoffMs(finding: TimelineEvent, segments: TranscriptSegment[]): number {
  const spoken = segments
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  const containing = spoken.find((s) => s.startMs <= finding.atMs && finding.atMs <= s.endMs);
  if (containing) return containing.endMs;
  const sameSecond = spoken.find((s) => s.startMs >= finding.atMs && s.startMs < finding.atMs + 1000);
  if (sameSecond) return sameSecond.endMs;
  let nearestBefore: TranscriptSegment | null = null;
  for (const s of spoken) {
    if (s.startMs <= finding.atMs) nearestBefore = s;
  }
  return nearestBefore?.endMs ?? finding.atMs;
}

export function segmentsKnownAtFinding(segments: TranscriptSegment[], finding: TimelineEvent): TranscriptSegment[] {
  const cutoffMs = findingCutoffMs(finding, segments);
  return segments.filter((s) => s.isFinal && s.text.trim() && s.startMs <= cutoffMs);
}

export function buildFindingSolutionPrompt(opts: {
  context: string;
  finding: TimelineEvent;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  mode?: FindingSolutionMode;
}): string {
  const { context, finding, segments, names, mode = "replay" } = opts;
  // At-moment context must stop at the selected turn; otherwise an old live
  // finding opened later can leak future negotiation content into the advice.
  const knownTranscript = transcriptWithTimestamps(segmentsKnownAtFinding(segments, finding), names);
  const fullTranscript = transcriptWithTimestamps(segments, names);

  // The moment is anchored by its timestamp; the model locates the surrounding
  // exchange in the timestamped transcript below (no quotes are stored).
  const moment =
    `The moment to reply to (at ${formatClock(finding.atMs)} in the transcript below, side = ${finding.side}):\n` +
    `- ${finding.title}: ${finding.detail}`;

  // If the retro already found ME defused this moment, hand the model MY actual
  // response so the suggestions build on it without treating later facts as
  // knowledge available at the moment.
  const resolvedBlock =
    finding.resolved && finding.resolution?.trim()
      ? `\n\nME ALREADY RESPONDED to this moment later in the conversation:\n- ${finding.resolution.trim()}\n` +
        `This is hindsight context from after the moment. If it worked, you may give replies that reinforce or extend the same move; if it was weak or incomplete, give a stronger version. Do NOT imply ME knew later facts at the moment.`
      : "";

  const modeBlock =
    mode === "live"
      ? `MODE: REALTIME ADVICE.
Use ONLY the "Transcript known at this moment" below when drafting reply lines and considerations. Do not use any content after ${formatClock(finding.atMs)}; it is not provided because ME would not know it yet. Make the options actionable next steps: ask, clarify, test criteria, protect leverage, or trade.`
      : `MODE: POST-EVALUATION COACHING.
Draft what ME should have said using the "Transcript known at this moment" as the factual boundary for the reply itself. You may use the full transcript only as HINDSIGHT to improve coaching. If a consideration relies on later behavior, explicitly start it with "Hindsight:" (or the equivalent in the transcript language). Never make a reply line depend on facts ME learned only later.`;

  const hindsightBlock =
    mode === "replay" && fullTranscript !== knownTranscript
      ? `\n\nFull transcript for HINDSIGHT only:\n${fullTranscript || "(no transcript)"}`
      : "";

  return `${context}${modeBlock}\n\n${moment}${resolvedBlock}\n\nTranscript known at this moment:\n${knownTranscript || "(no transcript)"}${hindsightBlock}\n\nGive ME the reply options — each a line MY side would say next, never THEM's.`;
}

/**
 * Generate the "how should I reply" solution for ONE finding. LIVE uses only
 * context available at that moment; REPLAY also provides the full transcript as
 * explicitly labeled hindsight so coaching can learn from later behavior without
 * pretending ME knew it in the moment.
 */
export async function generateFindingSolution(opts: {
  settings: Settings;
  finding: TimelineEvent;
  segments: TranscriptSegment[];
  meetingContext?: string;
  names?: Record<string, string>;
  mode?: FindingSolutionMode;
}): Promise<FindingSolution> {
  const { settings, finding, segments, meetingContext, names, mode = "replay" } = opts;

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  const { object, usage } = await generateObjectResilient({
    settings,
    kind: "eval",
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: buildFindingSolutionPrompt({ context: ctx, finding, segments, names, mode }),
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
