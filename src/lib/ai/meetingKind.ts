import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import { MEETING_KINDS } from "../analysis/lens";
import { log } from "../log";
import { meetingContextBlock, STUDY } from "./studyPrompt";
import type { MeetingKind, Settings, TranscriptSegment } from "../types";

const schema = z.object({
  kind: z
    .enum(["internal", "sales", "pricing", "rivalry"])
    .describe("Which of the four kinds this meeting is."),
});

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

  const ctx = profileContext(settings) + meetingContextBlock(meetingContext);

  try {
    const { object, usage } = await streamObjectResilient({
      settings,
      workload: "realtime",
      schema,
      system: STUDY.meetingKind.system + JSON_MODE_INSTRUCTION,
      prompt: `${ctx}${STUDY.meetingKind.transcriptHeader}\n${transcript}`,
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
