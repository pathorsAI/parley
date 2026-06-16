import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions } from "./provider";
import { transcriptAsText, useStore } from "../store";
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
  const mc = useStore.getState().meetingContext.trim();
  const ctx = profileContext(settings) + (mc ? `Meeting context: ${mc}\n\n` : "");

  const { object, usage } = await generateObject({
    model: getModel(settings, "ask"),
    providerOptions: getProviderOptions(settings, "ask"),
    schema,
    system:
      "You track a meeting checklist. Given the checklist items and the live transcript, " +
      "return the ids of items that have genuinely been addressed or covered. Be conservative — " +
      "only mark an item done if the transcript clearly shows it was handled.",
    prompt: `${ctx}Checklist (id and text):\n${list}\n\nTranscript so far:\n${transcript}`,
  });
  void recordLlmUsage(settings, "ask", "todo", usage);

  const validIds = new Set(open.map((t) => t.id));
  return object.done_ids.filter((id) => validIds.has(id));
}
