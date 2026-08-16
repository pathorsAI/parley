import { streamText } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { profileFacts, outputLanguageInstruction } from "./profile";
import { recordLlmUsage } from "../usage/log";
import { factsDigest, type PrepFacts } from "../preflight/facts";
import { log } from "../log";
import type { Settings } from "../types";

/**
 * The pre-meeting copilot (issue: 會前準備 v2).
 *
 * Everything here reads the claim base and writes nothing. The user's own three
 * inputs — who, what kind of call, and a pasted lump of background — stay the
 * only things they have to produce; BATNA, bottom line, agenda and objections
 * are drafted from what the system already knows and then corrected by hand.
 *
 * The one rule every prompt below repeats: an invented number is worse than a
 * blank. A fabricated BATNA would flow straight into the negotiation
 * evaluations (see evaluations/presets) and quietly score the live call against
 * a fiction.
 */

const COACH = `You are ME's pre-meeting coach, twenty minutes before a real call that matters.

You have been handed everything the system knows about this call: which customer it is with, what kind of call it is, the board this stage wants covered, the earlier calls, and whatever ME has already written down. Your job is to turn it into something ME can walk in with.

How to behave:
- Say what you SEE first, then ask exactly ONE question. Never a list of questions.
- Ground every statement in the facts you were given. When something is unknown, say so plainly and treat it as a question to chase in the room — never invent a budget, a headcount, a competitor's price, or a person.
- Be concrete. "Ask about budget" is useless; "their fleet is going to 5,000 units — ride that to ask who signs off on this batch" is useful. Name the actual sentence or question.
- Never ask ME for something the facts already contain.
- Be short. ME is skimming, already standing up.`;

/** Shared preamble: who I am + everything known about this call. */
function grounding(settings: Settings, facts: PrepFacts): string {
  return `${profileFacts(settings)}${factsDigest(facts)}`;
}

/**
 * Stream one turn of the pre-meeting conversation. `history` is the exchange so
 * far (oldest first), `question` the turn being asked now.
 */
export async function streamPrepChat(opts: {
  settings: Settings;
  facts: PrepFacts;
  history: { role: "user" | "assistant"; content: string }[];
  question: string;
  onDelta: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, facts, history, question, onDelta, onReasoningDelta, signal } = opts;

  const system =
    COACH +
    outputLanguageInstruction(settings) +
    `\n\n--- WHAT IS KNOWN ABOUT THIS CALL ---\n${grounding(settings, facts)}`;

  log.info("ai.prep: chat start", {
    folder: facts.folder,
    turns: history.length,
    slots: facts.board.length,
  });

  let full = "";
  try {
    const result = streamText({
      model: getModel(settings, "realtime"),
      providerOptions: getProviderOptions(settings, "realtime"),
      system,
      abortSignal: signal,
      messages: [...history, { role: "user" as const, content: question }],
    });
    // fullStream surfaces errors as parts instead of throwing — re-throw so
    // callers keep a single error path (same shape as ai/ask).
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        full += part.text;
        onDelta(part.text);
      } else if (part.type === "reasoning-delta") {
        onReasoningDelta?.(part.text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    void (async () => {
      try {
        await recordLlmUsage(settings, "realtime", "prep-chat", await result.usage);
      } catch {
        /* best-effort logging */
      }
    })();
  } catch (e) {
    log.error("ai.prep: chat failed", { error: String(e) });
    throw e;
  }
  log.info("ai.prep: chat ok", { chars: full.length });
  return full;
}

// ── The battle plan ─────────────────────────────────────────────────────────

const planSchema = z.object({
  agenda: z
    .array(z.string())
    .describe("3-6 concrete things to walk out of this call having got"),
  idealPath: z
    .array(z.object({ move: z.string(), why: z.string() }))
    .describe("3-5 ordered moves — how the call goes when it goes well"),
  edgeCases: z
    .array(z.object({ trigger: z.string(), move: z.string() }))
    .describe("2-4 moments this call could go sideways, and the counter for each"),
  target: z.string().describe("the goal for this call in one line, or empty string"),
  batna: z
    .string()
    .describe("my real best alternative if this deal dies, or EMPTY STRING if unknowable"),
  floor: z
    .string()
    .describe("the line I walk away below, or EMPTY STRING if unknowable"),
});

export interface PrepPlan extends z.infer<typeof planSchema> {}

const PLAN_SYSTEM =
  "You are writing ME's plan for ONE upcoming call, from the facts and the conversation " +
  "you just had with ME. Produce a sequenced play, not a flat list: `idealPath` is how the call " +
  "goes when it goes WELL, in order, each move with one line of why. `edgeCases` are the specific " +
  "moments it goes sideways — the trigger stated as something the other side actually does or says, " +
  "and the counter-move stated as something ME actually says or does. `agenda` items are checkable: " +
  "after the call it must be obvious whether each was got.\n\n" +
  "CRITICAL — `batna` and `floor`: fill these ONLY when the facts or the conversation genuinely " +
  "support them. If ME has never established a real walk-away alternative or a real bottom line, " +
  "return an empty string. A plausible-sounding invented BATNA is worse than a blank one: it feeds " +
  "the live negotiation analysis and would score the whole call against a fiction." +
  JSON_MODE_INSTRUCTION;

/** Turn the facts + the conversation into the plan the user reviews. */
export async function draftPlan(opts: {
  settings: Settings;
  facts: PrepFacts;
  history: { role: "user" | "assistant"; content: string }[];
}): Promise<PrepPlan> {
  const { settings, facts, history } = opts;

  const conversation = history.length
    ? `\n\nWhat ME and I just worked through:\n${history
        .map((m) => `${m.role === "user" ? "ME" : "COACH"}: ${m.content}`)
        .join("\n\n")}`
    : "";

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "deep",
    schema: planSchema,
    system: PLAN_SYSTEM + outputLanguageInstruction(settings),
    prompt: grounding(settings, facts) + conversation,
  });
  void recordLlmUsage(settings, "deep", "prep-plan", usage);

  const plan: PrepPlan = {
    agenda: object.agenda.map((a) => a.trim()).filter(Boolean),
    idealPath: object.idealPath.filter((s) => s.move.trim()),
    edgeCases: object.edgeCases.filter((s) => s.trigger.trim() && s.move.trim()),
    target: object.target.trim(),
    batna: object.batna.trim(),
    floor: object.floor.trim(),
  };
  log.info("ai.prep: plan", {
    folder: facts.folder,
    agenda: plan.agenda.length,
    path: plan.idealPath.length,
    edges: plan.edgeCases.length,
    batna: !!plan.batna,
  });
  return plan;
}
