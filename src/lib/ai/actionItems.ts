import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { parseClockMs } from "./timeline";
import type { ActionItem, Settings, TimelineEvent, TranscriptSegment } from "../types";

// Strict json_schema: every property present, `.nullable()` not `.optional()`.
const itemSchema = z.object({
  text: z.string().describe("A concrete next step / follow-up ME should take after this meeting."),
  rationale: z
    .string()
    .describe('Why it matters, grounded in what happened — e.g. "you left their pricing question unanswered".'),
  linkedEventId: z
    .string()
    .nullable()
    .describe("The id of the finding this derives from, or null for a general item."),
  time: z
    .string()
    .nullable()
    .describe("The [m:ss] moment this relates to, copied from the transcript, or null."),
});
const schema = z.object({ items: z.array(itemSchema) });

const SYSTEM = `You are writing the POST-MEETING ACTION ITEMS for the user ("ME") after a finished negotiation/interview against the other party ("THEM"). The meeting is OVER.

You are given the FINDINGS from the retro analysis (notable moments, each with an id) and the full timestamped transcript. Produce a short, concrete list of follow-up ACTIONS ME should take next — things to send, clarify, prepare, decide, or do differently next time. For each action:
- text: the concrete next step, phrased as an action ME can do.
- rationale: one sentence on why, grounded in what happened.
- linkedEventId: the finding id it derives from when it maps to one, else null.
- time: the [m:ss] it relates to (copy a real transcript timestamp), else null.

Be selective — surface the actions that genuinely matter (typically 3-7), not busywork. Ground everything in what was actually said. Respond ENTIRELY in the language of the transcript.`;

/**
 * Generate post-meeting action items from the whole-recording analysis findings
 * plus the full transcript. Each item links back to the finding/moment that
 * motivated it (when one applies) so the UI can seek to it. REPLAY-only.
 */
export async function generateActionItems(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  findings: TimelineEvent[];
  meetingContext?: string;
  names?: Record<string, string>;
}): Promise<ActionItem[]> {
  const { settings, segments, findings, meetingContext, names } = opts;
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return [];

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");
  const findingsList = findings.length
    ? findings.map((f) => `### id: ${f.id}\n[${f.side}] ${f.title}: ${f.detail}`).join("\n\n")
    : "(no findings)";

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}Findings:\n${findingsList}\n\nFull transcript:\n${transcript}`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  const byId = new Map(findings.map((f) => [f.id, f]));
  return object.items.map((it) => {
    const linked = it.linkedEventId && byId.has(it.linkedEventId) ? byId.get(it.linkedEventId)! : null;
    const atMs = linked ? linked.atMs : parseClockMs(it.time ?? undefined);
    return {
      id: crypto.randomUUID(),
      text: it.text,
      rationale: it.rationale,
      done: false,
      linkedEventId: linked ? linked.id : null,
      atMs: atMs ?? null,
      severity: linked?.severity,
    };
  });
}
