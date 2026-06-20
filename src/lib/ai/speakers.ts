import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { speakerLabel } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { Settings, SpeakerRole, TranscriptSegment } from "../types";

const schema = z.object({
  assignments: z
    .array(
      z.object({
        i: z.number().describe("0-based line index from the transcript below."),
        r: z.number().describe("1-based role number this line was spoken by."),
      })
    )
    .describe("One entry per transcript line, mapping line index to a role number."),
});

const SYSTEM = `You re-attribute speakers in a meeting transcript whose automatic speaker diarization was UNRELIABLE (it merged or split people wrongly). You are given a fixed set of ROLES and the transcript with each line indexed. Decide, for EVERY line, which role most likely said it — using conversational flow, turn-taking, who asks vs. answers, self-references, names, and topic ownership. Adjacent lines are often the same speaker; speaker changes usually happen at question/answer boundaries or topic shifts. Use ONLY the role numbers provided. Return one assignment per line index.`;

/**
 * Ask the LLM to re-assign each transcript line to one of the user's roles.
 * Returns a map of line index (into the passed `segments` array) → 1-based role
 * number. Lines the model omits or assigns out of range are left for the caller
 * to default. Throws on API failure (caller surfaces it).
 */
export async function reassignSpeakers(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  roles: SpeakerRole[];
  names?: Record<string, string>;
}): Promise<Map<number, number>> {
  const { settings, segments, roles, names } = opts;
  if (roles.length < 2 || segments.length === 0) return new Map();

  const roleList = roles
    .map((role, idx) => `${idx + 1}. ${role.name}${role.hint?.trim() ? ` — ${role.hint.trim()}` : ""}`)
    .join("\n");

  // Index every line; include the current (unreliable) label only as weak context.
  const lines = segments
    .map((s, i) => `[${i}] (${speakerLabel(s, names)}) ${s.text.trim()}`)
    .join("\n");

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema,
    // Big transcripts produce one assignment per line — give the output room.
    maxOutputTokens: 16000,
    system: SYSTEM + JSON_MODE_INSTRUCTION,
    prompt:
      profileContext(settings) +
      `Roles (use these role numbers):\n${roleList}\n\n` +
      `Transcript (${segments.length} lines):\n${lines}`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  const maxRole = roles.length;
  const map = new Map<number, number>();
  for (const a of object.assignments) {
    if (
      Number.isInteger(a.i) &&
      a.i >= 0 &&
      a.i < segments.length &&
      Number.isInteger(a.r) &&
      a.r >= 1 &&
      a.r <= maxRole
    ) {
      map.set(a.i, a.r);
    }
  }
  return map;
}
