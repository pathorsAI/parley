import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { parseClockMs } from "./timeline";
import { actionsIntro } from "../analysis/lens";
import { fillPrompt, meetingContextBlock, STUDY } from "./studyPrompt";
import type { AnalysisLens, ActionItem, Settings, TimelineEvent, TranscriptSegment } from "../types";

// Strict json_schema: every property present, `.nullable()` not `.optional()`.
const itemSchema = z.object({
  text: z.string().describe("A concrete next step / follow-up ME should take after this meeting."),
  linkedEventId: z
    .string()
    .nullable()
    .describe("The id of the finding this derives from, or null for a general item."),
  time: z
    .string()
    .nullable()
    .describe("The [m:ss] moment this relates to, copied from the transcript, or null."),
});
// Key is "actions" to match the prompt's vocabulary — in json_object mode (Groq)
// the key isn't server-enforced, so a mismatch makes the model emit its own and
// the parse fails. Keep schema key + prompt aligned (cf. timeline's "moments").
const schema = z.object({ actions: z.array(itemSchema) });

/** The system prompt for one lens — text in shared/prompts/study.json (`actionItems.*`). */
function systemFor(lens: AnalysisLens): string {
  const A = STUDY.actionItems;
  return fillPrompt(A.systemTemplate, {
    intro: actionsIntro(lens),
    flavour: lens === "decision" ? A.flavour.decision : A.flavour.default,
  });
}

/** A (possibly half-streamed) raw action item — every field may be absent. */
type RawItem = { text?: string | null; linkedEventId?: string | null; time?: string | null };

/** Resolve ONE raw item → an ActionItem, or null if it isn't ready yet. `id` is
 *  caller-supplied so it's stable across partial updates. */
function mapActionItem(it: RawItem, id: string, byId: Map<string, TimelineEvent>): ActionItem | null {
  if (!it.text) return null; // still streaming → don't show a blank row
  const linked = it.linkedEventId && byId.has(it.linkedEventId) ? byId.get(it.linkedEventId)! : null;
  const atMs = linked ? linked.atMs : parseClockMs(it.time ?? undefined);
  return {
    id,
    text: it.text,
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
  /** How to frame the follow-ups. Defaults to plain meeting notes. */
  lens?: AnalysisLens;
  names?: Record<string, string>;
  /** Called with the cumulative items as they stream in. */
  onPartial?: (items: ActionItem[]) => void;
  /** Cancels the pass (the run was superseded). The call also has its own
   *  deadline — see streamObjectResilient. */
  signal?: AbortSignal;
}): Promise<ActionItem[]> {
  const { settings, segments, findings, meetingContext, names, lens = "decision", onPartial, signal } = opts;
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return [];

  const A = STUDY.actionItems;
  const ctx = profileContext(settings) + meetingContextBlock(meetingContext);
  const findingsList = findings.length
    ? findings
        .map((f) =>
          fillPrompt(A.findingEntry, {
            id: f.id,
            tag: f.side ?? f.category ?? A.findingTagFallback,
            title: f.title,
            detail: f.detail,
          })
        )
        .join("\n\n")
    : A.noFindings;

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
    workload: "deep",
    schema,
    system: systemFor(lens) + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}${A.findingsHeader}\n${findingsList}\n\n${A.transcriptHeader}\n${transcript}`,
    signal,
    onPartial: (p) => {
      if (!onPartial) return;
      const placed = placeItems((p as { actions?: (RawItem | undefined)[] }).actions);
      if (placed.length === emittedCount) return;
      emittedCount = placed.length;
      onPartial(placed);
    },
  });
  void recordLlmUsage(settings, "deep", "action-items", usage);

  return placeItems(object.actions);
}
