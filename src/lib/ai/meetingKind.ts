import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import { MEETING_KINDS } from "../analysis/lens";
import { log } from "../log";
import type { MeetingKind, Settings, TranscriptSegment } from "../types";

const schema = z.object({
  kind: z
    .enum(["internal", "sales", "pricing", "rivalry"])
    .describe("Which of the four kinds this meeting is."),
});

const SYSTEM = `Classify a finished meeting transcript into EXACTLY ONE kind, so the right analysis can be run over it. Answer with the kind alone.

- "internal": a working meeting among people ON THE SAME SIDE — a team discussion, design/product review, planning or roadmap session, project sync, retro, 1:1. Nobody is selling to anybody; the output is decisions and follow-ups. This is also where a meeting that fits NONE of the others belongs.
- "sales": ME is selling to, or qualifying, a prospect or customer — discovery, demo, solution pitch, follow-up call. The other party is evaluating whether to buy. Commercial terms may come up, but the call is still about fit and value.
- "pricing": the deal is already wanted by both sides and the conversation is about TERMS — price, discount, scope, payment, contract clauses, renewal. Concrete numbers are being pushed back and forth.
- "rivalry": ME is across the table from a competitor, a rival, or a party whose interests genuinely conflict — carving up a market, a partnership between competitors, a dispute, a hard procurement standoff. Information leakage and non-committal wording matter more than closing.

Judge the WHOLE conversation by what it was FOR, not by isolated words: one mention of a price inside a design review is still "internal", and a hard-fought discount conversation with an existing customer is "pricing", not "sales". When a sales call is genuinely dominated by haggling terms, prefer "pricing"; when you are torn between "internal" and anything else and the participants are plainly colleagues, choose "internal".`;

/** Type guard for a model-supplied kind string. */
function isKind(v: unknown): v is MeetingKind {
  return typeof v === "string" && (MEETING_KINDS as string[]).includes(v);
}

/**
 * Classify a recording into a {@link MeetingKind}. Rides the cheap realtime lane
 * — it is one short label off an already-transcribed conversation, and the deep
 * lane is about to spend real tokens on the analysis this answer shapes.
 *
 * Returns null when there is nothing to judge or the pass fails; callers fall
 * back to the decision lens (see lensOf), never to an adversarial reading.
 */
export async function detectMeetingKind(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  meetingContext?: string;
  names?: Record<string, string>;
}): Promise<MeetingKind | null> {
  const { settings, segments, meetingContext, names } = opts;
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return null;

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  try {
    const { object, usage } = await streamObjectResilient({
      settings,
      workload: "realtime",
      schema,
      system: SYSTEM + JSON_MODE_INSTRUCTION,
      prompt: `${ctx}Transcript:\n${transcript}`,
    });
    void recordLlmUsage(settings, "realtime", "eval", usage);
    const kind = object.kind;
    if (!isKind(kind)) return null;
    log.info("ai.meetingKind: detected", { kind });
    return kind;
  } catch (e) {
    log.warn("ai.meetingKind: failed", { error: String(e) });
    return null;
  }
}
