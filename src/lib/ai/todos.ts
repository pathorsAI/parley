import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { transcriptAsText, useStore, meetingBriefText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { Settings, TodoItem, TranscriptSegment } from "../types";

const schema = z.object({
  done_ids: z
    .array(z.string())
    .describe("IDs of checklist items that have clearly been addressed/covered/answered in the conversation so far."),
});

/**
 * Ask the LLM which checklist items have been covered in the meeting so far.
 * Returns the set of todo ids it considers done.
 */
export async function checkTodos(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  todos: TodoItem[];
  names?: Record<string, string>;
}): Promise<string[]> {
  const { settings, segments, todos, names } = opts;
  const open = todos.filter((t) => !t.done);
  if (open.length === 0) return [];

  const transcript = transcriptAsText(segments, names);
  if (!transcript.trim()) return [];

  const list = open.map((t) => `- [${t.id}] ${t.text}`).join("\n");
  const mc = meetingBriefText(useStore.getState()).trim();
  const ctx = profileContext(settings) + (mc ? `Meeting context: ${mc}\n\n` : "");

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    schema,
    system:
      "You track a meeting checklist. Given the checklist items and the live transcript, " +
      "return the ids of items that have genuinely been addressed or covered. Be conservative — " +
      "only mark an item done if the transcript clearly shows it was handled." +
      JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Checklist (id and text):\n${list}\n\nTranscript so far:\n${transcript}`,
  });
  void recordLlmUsage(settings, "realtime", "todo", usage);

  const validIds = new Set(open.map((t) => t.id));
  return object.done_ids.filter((id) => validIds.has(id));
}
