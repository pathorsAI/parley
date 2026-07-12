import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { profileContext } from "../ai/profile";
import { recordLlmUsage } from "../usage/log";
import type { Settings } from "../types";
import type { SalesStage } from "./types";
import type { SlotDef } from "./bundles";

/**
 * 建議問法 (#148, design §5): tap a gap → 2–3 speakable questions that chase
 * exactly that slot, riding the conversation's tail. Realtime lane — this is
 * an in-call surface, latency beats depth.
 */

/** One suggested probe: say `reply` as-is; `consideration` = what it's fishing for. */
export interface SlotQuestion {
  reply: string;
  consideration: string;
}

const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        reply: z
          .string()
          .describe(
            "the question to ask, verbatim, business-natural in the transcript/UI language"
          ),
        consideration: z.string().describe("ONE short line: what this question is fishing for"),
      })
    )
    .describe("2-3 distinct ready-to-ask questions"),
});

// §5 語感鐵則, verbatim into the prompt contract.
const SYSTEM =
  "You coach a salesperson mid-call. Craft 2-3 questions that fill ONE specific intel gap. " +
  "Iron rules: ride the conversation — reference words the counterpart actually used when a " +
  "transcript is given; open-ended first (EXCEPT demo stage: closed questions you already know " +
  "the answer to); ONE ask per question; never sound like a survey. Canned lines like " +
  "'what is your budget?' are failures. Never re-ask what the KNOWN list already answers. " +
  "Write questions in the same language as the UI copy of the slot description." +
  JSON_MODE_INSTRUCTION;

export async function suggestSlotQuestions(opts: {
  settings: Settings;
  stage: SalesStage;
  slot: SlotDef;
  /** What we already know for this slot — the model must not re-ask it. */
  knownTexts: string[];
  /** Tail of the live transcript (speaker-attributed); empty pre-call. */
  transcriptTail: string;
}): Promise<SlotQuestion[]> {
  const { settings, stage, slot, knownTexts, transcriptTail } = opts;
  const prompt =
    profileContext(settings) +
    `Sales stage: ${stage}\n` +
    `The gap to fill — ${slot.label}: ${slot.hint}\n` +
    (knownTexts.length ? `\nKNOWN already (do not re-ask):\n${knownTexts.map((x) => `- ${x}`).join("\n")}\n` : "") +
    (transcriptTail.trim()
      ? `\nConversation so far (tail — ride it):\n${transcriptTail}`
      : "\nThe call has not started yet — craft natural openers for this gap.");
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    schema: questionsSchema,
    system: SYSTEM,
    prompt,
  });
  void recordLlmUsage(settings, "realtime", "accounts-slot-suggest", usage);
  return object.questions.filter((q) => q.reply.trim()).slice(0, 3);
}
