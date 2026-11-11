import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { transcriptWithTimestamps, useStore, meetingBriefText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { Settings, TodoItem, TranscriptSegment } from "../types";
import { parseClock, type AgendaCheck } from "../meeting/agenda";

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

/**
 * Ask the LLM which checklist items have been covered in the meeting so far,
 * and where: the transcript goes in with its [m:ss] stamps and each covered
 * item comes back with the stamp of the line that covered it, so the agenda
 * can jump there. An item the user unticked after the AI ticked it
 * (aiDismissed) is not asked about again.
 */
export async function checkTodos(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  todos: TodoItem[];
  names?: Record<string, string>;
}): Promise<AgendaCheck[]> {
  const { settings, segments, todos, names } = opts;
  const open = todos.filter((t) => !t.done && !t.aiDismissed);
  if (open.length === 0) return [];

  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return [];

  const list = open.map((t) => `- [${t.id}] ${t.text}`).join("\n");
  const mc = meetingBriefText(useStore.getState()).trim();
  const ctx = profileContext(settings) + (mc ? `Meeting context: ${mc}\n\n` : "");

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema,
    system:
      "You track a meeting checklist. Given the checklist items and the live transcript, " +
      "return the items that have genuinely been addressed or covered, each with the [m:ss] stamp of " +
      "the line where it was covered. Be conservative — only mark an item done if the transcript " +
      "clearly shows it was handled." +
      JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Checklist (id and text):\n${list}\n\nTranscript so far:\n${transcript}`,
  });
  void recordLlmUsage(settings, "realtime", "todo", usage);

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
