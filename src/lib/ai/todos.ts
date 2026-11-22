import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { transcriptWithTimestamps, useStore, meetingBriefText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { Settings, TodoItem, TranscriptSegment } from "../types";
import { parseClock, type AgendaCheck } from "../meeting/agenda";
import { commitAgendaCheck, planAgendaCheck, type AgendaCursor } from "../meeting/agendaDelta";
import { formatClock } from "../analysis/transcriptText";
import { labelContextOf, speakerLabel } from "../speakers/labels";

const schema = z.object({
  done: z
    .array(
      z.object({
        id: z.string().describe("The checklist item's id."),
        at: z
          .string()
          .describe("The [m:ss] (or [h:mm:ss]) stamp of the transcript line where it was covered, without brackets."),
      }),
    )
    .describe("Checklist items that have clearly been addressed/covered/answered in the conversation so far."),
});

const SYSTEM =
  "You track a meeting checklist. Given the checklist items and the live transcript, " +
  "return the items that have genuinely been addressed or covered, each with the [m:ss] stamp of " +
  "the line where it was covered. Be conservative — only mark an item done if the transcript " +
  "clearly shows it was handled.";

const DELTA_NOTE =
  " Every listed item is still open. You only see what was said since the last check, after a few " +
  "earlier lines given for context: judge each item by the new lines (an item may begin in the " +
  "context and conclude in the new lines). Items not covered by them stay open.";

type AgendaPrompt = { body: string; plan: ReturnType<typeof planAgendaCheck> };

/** The live meeting's prompt body: only speech new since the cursor's last
 *  pass, behind a few already-checked lines. Null when nothing new was said. */
function deltaPrompt(
  cursor: AgendaCursor,
  segments: TranscriptSegment[],
  open: TodoItem[],
  names: Record<string, string> | undefined,
): AgendaPrompt | null {
  // Speaker labels read the whole meeting, so a slice is labelled as the full transcript would be.
  const labels = labelContextOf(segments);
  const line = (s: TranscriptSegment) =>
    `[${formatClock(s.startMs)}] [${speakerLabel(s, names, labels)}] ${s.text.trim()}`;
  const plan = planAgendaCheck(cursor, segments, open, line);
  if (!plan) return null;
  const fresh = plan.fresh.map(line).join("\n");
  const body = plan.context.length
    ? `Earlier lines (already checked, context only):\n${plan.context.map(line).join("\n")}\n\nNew since the last check:\n${fresh}`
    : `New since the last check:\n${fresh}`;
  return { body, plan };
}

/** A one-off check's prompt body: the whole transcript. Null when it is empty. */
function fullPrompt(
  segments: TranscriptSegment[],
  names: Record<string, string> | undefined,
): AgendaPrompt | null {
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return null;
  return { body: `Transcript so far:\n${transcript}`, plan: null };
}

/**
 * Ask the LLM which checklist items have been covered in the meeting so far,
 * and where: the transcript goes in with its [m:ss] stamps and each covered
 * item comes back with the stamp of the line that covered it, so the agenda
 * can jump there. An item the user unticked after the AI ticked it
 * (aiDismissed) is not asked about again.
 *
 * With a `cursor` (the live meeting's), only speech new since the cursor's
 * last successful pass is sent, behind a few already-checked lines of
 * context, and there is no call at all when nothing new was said. The cursor
 * advances only when the model answers. Without one, the whole transcript
 * goes in, as a one-off check.
 */
export async function checkTodos(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  todos: TodoItem[];
  names?: Record<string, string>;
  cursor?: AgendaCursor;
}): Promise<AgendaCheck[]> {
  const { settings, segments, todos, names, cursor } = opts;
  const open = todos.filter((t) => !t.done && !t.aiDismissed);
  if (open.length === 0) return [];

  const prompt = cursor ? deltaPrompt(cursor, segments, open, names) : fullPrompt(segments, names);
  if (!prompt) return [];
  const { body, plan } = prompt;

  const list = open.map((t) => `- [${t.id}] ${t.text}`).join("\n");
  const mc = meetingBriefText(useStore.getState()).trim();
  const ctx = profileContext(settings) + (mc ? `Meeting context: ${mc}\n\n` : "");

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema,
    system: SYSTEM + (plan ? DELTA_NOTE : "") + JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Checklist (id and text):\n${list}\n\n${body}`,
  });
  void recordLlmUsage(settings, "realtime", "todo", usage);
  if (cursor && plan) commitAgendaCheck(cursor, plan);

  const validIds = new Set(open.map((t) => t.id));
  const seen = new Set<string>();
  const checks: AgendaCheck[] = [];
  for (const d of object.done) {
    if (!validIds.has(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    checks.push({ id: d.id, atMs: parseClock(d.at) });
  }
  return checks;
}
