import { z } from "zod";
import { generateObjectResilient } from "./generate";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { outputLanguageInstruction, profileContext } from "./profile";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
import type { Settings } from "../types";
import type { SlotDef } from "../scenarios/bundleFile";

/**
 * Pre-meeting DRAFT (#189): one LLM pass that proposes what the user was
 * previously asked to type from nothing — the meeting's objective, the actions
 * to take, the pushbacks to expect, and the BATNA / walk-away line.
 *
 * Why this exists at all: 目標 / BATNA / 底線 are CONCLUSIONS, not raw material.
 * Asking for them in empty inputs asks the user to have already finished
 * thinking, so in practice the whole column got skipped. Everything needed to
 * draft them is the stage's board, its exit criteria and whatever background
 * the user pasted in. So the machine writes the first version and the user
 * corrects it; nothing here is applied until the user clicks a suggestion.
 */

const schema = z.object({
  goals: z
    .array(z.string())
    .describe(
      "EXACTLY 3 candidate objectives for THIS single meeting, one line each. Each must be " +
        "verifiable before the call ends and name a concrete thing to obtain."
    ),
  agenda: z
    .array(z.string())
    .describe(
      "UP TO 5 ordered ACTIONS I take in the meeting (ask X, propose Y, confirm Z). Short imperative lines."
    ),
  objections: z
    .array(z.string())
    .describe(
      "UP TO 3 pushbacks they are likely to raise, each written as `their objection → my counter`."
    ),
  batna: z
    .string()
    .describe("My best alternative if this meeting produces nothing, ONE line. Empty string if the intel gives no basis."),
  floor: z
    .string()
    .describe("The walk-away line for this meeting, ONE line. Empty string if the intel gives no basis."),
});

/** What the model returns, after clamping. */
export interface PrepDraft {
  goals: string[];
  agenda: string[];
  objections: string[];
  batna: string;
  floor: string;
}

export interface PrepDraftInput {
  /** The folder this call files into — one folder, one customer. */
  folder: string | null;
  /** Display name of the stage this meeting opens on. */
  stageName: string;
  /** The stage's one-line goal, when its bundle carries one. */
  stageGoal: string;
  /** What "done" looks like for the stage. */
  exitCriteria: string[];
  /** Every slot on the stage's board, in question order. */
  slots: SlotDef[];
  /** Past calls with this customer, newest first. */
  meetings: { title: string; createdAt: number }[];
  /** Whatever the user already typed as background — steers the draft. */
  context: string;
}

const SYSTEM =
  "You are a senior sales strategist preparing ME for ONE upcoming meeting. You are writing a " +
  "DRAFT that I will edit in seconds — not a report. Every line must be short enough to read " +
  "while walking into the room.\n\n" +
  "goals: three DIFFERENT candidate objectives, so I can pick the one that matches my real " +
  "intent. Each names something concrete I can walk out holding — 'find out who signs off " +
  "below NT$300k', not 'convey our value'. Prefer objectives that close the board's empty slots " +
  "or satisfy an exit criterion.\n\n" +
  "agenda: what I DO, in order — ask this, propose that, confirm the other. It is NOT a list of " +
  "information to collect; the gap board already tracks that, and duplicating it there has " +
  "burned us before. Skip anything already solid on the board.\n\n" +
  "objections: only pushbacks the background actually supports — a stated budget worry, a named " +
  "competitor, a stalled approval. Each line is `what they say → how I answer`.\n\n" +
  "batna / floor: infer from the background. If it gives no honest basis, return an empty " +
  "string. A fabricated walk-away number is worse than none.\n\n" +
  "Rules: ground everything in what you were given — no invented facts, figures, or names; mark " +
  "anything you inferred rather than read with （推測）." +
  JSON_MODE_INSTRUCTION;

/** `- a\n- b` — the only list shape this prompt uses. */
function bullets(lines: string[]): string {
  return lines.map((x) => `- ${x}`).join("\n");
}

/**
 * Assemble the user prompt. Pure and exported so a test can assert the stage's
 * board actually reaches the model — the input that makes this draft worth more
 * than a generic checklist.
 */
export function buildPrepPrompt(settings: Settings, input: PrepDraftInput): string {
  const { folder, stageName, stageGoal, exitCriteria, slots, meetings, context } = input;
  const parts: string[] = [profileContext(settings)];

  if (folder) parts.push(`Meeting with: ${folder}`);
  const goalSuffix = stageGoal ? ` — ${stageGoal}` : "";
  parts.push(`Stage: ${stageName}${goalSuffix}`);
  if (exitCriteria.length) parts.push(`Stage is finished when:\n${bullets(exitCriteria)}`);

  // The board is the sharpest signal we have about what this meeting is FOR,
  // so it goes in whole.
  if (slots.length) {
    const lines = slots.map((s) =>
      s.hint && s.hint !== s.label ? `${s.label}：${s.hint}` : s.label
    );
    parts.push(`What this stage's board wants covered:\n${bullets(lines)}`);
  }

  if (meetings.length) {
    const lines = meetings
      .slice(0, 5)
      .map((m) => `${new Date(m.createdAt).toISOString().slice(0, 10)} ${m.title}`);
    parts.push(`Past calls with them (newest first):\n${bullets(lines)}`);
  }

  if (context.trim()) parts.push(`My own notes for this meeting:\n${context.trim()}`);

  return parts.filter(Boolean).join("\n\n");
}

/** Trim, drop blanks, de-duplicate, and cap — the model over-produces. */
function clean(list: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

/** Generate the pre-meeting draft. Nothing is written to the store here. */
export async function draftPrep(opts: {
  settings: Settings;
  input: PrepDraftInput;
}): Promise<PrepDraft> {
  const { settings, input } = opts;
  log.info("prep: draft start", {
    folder: input.folder,
    slots: input.slots.length,
    meetings: input.meetings.length,
  });

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "deep",
    schema,
    system: SYSTEM + outputLanguageInstruction(settings),
    prompt: buildPrepPrompt(settings, input),
  });
  void recordLlmUsage(settings, "deep", "prep-draft", usage);

  const draft: PrepDraft = {
    goals: clean(object.goals, 3),
    agenda: clean(object.agenda, 5),
    objections: clean(object.objections, 3),
    batna: (object.batna ?? "").trim(),
    floor: (object.floor ?? "").trim(),
  };
  log.info("prep: draft ok", {
    goals: draft.goals.length,
    agenda: draft.agenda.length,
    objections: draft.objections.length,
  });
  return draft;
}
