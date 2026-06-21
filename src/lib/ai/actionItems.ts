import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
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

/** A (possibly half-streamed) raw action item — every field may be absent. */
type RawItem = { text?: string | null; rationale?: string | null; linkedEventId?: string | null; time?: string | null };

/** Resolve ONE raw item → an ActionItem, or null if it isn't ready yet. `id` is
 *  caller-supplied so it's stable across partial updates. */
function mapActionItem(it: RawItem, id: string, byId: Map<string, TimelineEvent>): ActionItem | null {
  if (!it.text || !it.rationale) return null; // still streaming → don't show a blank row
  const linked = it.linkedEventId && byId.has(it.linkedEventId) ? byId.get(it.linkedEventId)! : null;
  const atMs = linked ? linked.atMs : parseClockMs(it.time ?? undefined);
  return {
    id,
    text: it.text,
    rationale: it.rationale,
    done: false,
    linkedEventId: linked ? linked.id : null,
    atMs: atMs ?? null,
    severity: linked?.severity,
  };
}

/**
 * Generate post-meeting action items from the whole-recording analysis findings
 * plus the full transcript. Each item links back to the finding/moment that
 * motivated it (when one applies) so the UI can seek to it. Streams items into
 * `onPartial` as they're produced. REPLAY-only.
 */
export async function generateActionItems(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  findings: TimelineEvent[];
  meetingContext?: string;
  names?: Record<string, string>;
  /** Called with the cumulative items as they stream in. */
  onPartial?: (items: ActionItem[]) => void;
}): Promise<ActionItem[]> {
  const { settings, segments, findings, meetingContext, names, onPartial } = opts;
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return [];

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");
  const findingsList = findings.length
    ? findings.map((f) => `### id: ${f.id}\n[${f.side}] ${f.title}: ${f.detail}`).join("\n\n")
    : "(no findings)";

  const byId = new Map(findings.map((f) => [f.id, f]));
  // Stable id per array index so streamed rows keep their identity as they fill in.
  const ids: string[] = [];
  const idAt = (i: number) => (ids[i] ??= crypto.randomUUID());
  const placeItems = (raw: ReadonlyArray<RawItem | undefined> | undefined): ActionItem[] => {
    const out: ActionItem[] = [];
    (raw ?? []).forEach((it, i) => {
      const a = it ? mapActionItem(it, idAt(i), byId) : null;
      if (a) out.push(a);
    });
    return out;
  };

  // Only push when a new item becomes placeable (see timeline.ts for rationale).
  let emittedCount = -1;
  const { object, usage } = await streamObjectResilient({
    settings,
    kind: "eval",
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}Findings:\n${findingsList}\n\nFull transcript:\n${transcript}`,
    onPartial: (p) => {
      if (!onPartial) return;
      const placed = placeItems((p as { items?: (RawItem | undefined)[] }).items);
      if (placed.length === emittedCount) return;
      emittedCount = placed.length;
      onPartial(placed);
    },
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  return placeItems(object.items);
}
