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

You have been handed everything the system knows about this account: the claim base, the gap board for this stage, past meetings, and the red lines. ME cannot hold all of that in their head — you can. Your job is to turn it into something ME can walk in with.

How to behave:
- Say what you SEE first, then ask exactly ONE question. Never a list of questions.
- Ground every statement in the facts you were given. When something is unknown, say so plainly and treat it as a question to chase in the room — never invent a budget, a headcount, a competitor's price, or a person.
- Be concrete. "Ask about budget" is useless; "their fleet is going to 5,000 units — ride that to ask who signs off on this batch" is useful. Name the actual sentence or question.
- The red lines are absolute. If what ME is planning would cross one, lead with that.
- Never ask ME for something the facts already contain.
- Be short. ME is skimming, already standing up.`;

/** Shared preamble: who I am + everything known about this account. */
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
    `\n\n--- WHAT IS KNOWN ABOUT THIS ACCOUNT ---\n${grounding(settings, facts)}`;

  log.info("ai.prep: chat start", {
    company: facts.company.name,
    turns: history.length,
    claims: facts.gaps.length,
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

// ── Goal candidates ─────────────────────────────────────────────────────────

const goalsSchema = z.object({
  goals: z
    .array(z.string())
    .describe(
      "exactly 3 candidate goals for THIS single call, each winnable in one conversation"
    ),
});

const GOALS_SYSTEM =
  "You propose candidate goals for ONE upcoming sales/negotiation call, from what is already known " +
  "about the account. Each goal must be: winnable inside a single conversation; concrete enough " +
  "that afterwards it is obvious whether it was won; and aimed at a gap the board shows is empty or " +
  "thin, or at the next move the account is already waiting on. Keep each under 20 characters of " +
  "Chinese or 8 words of English. Never propose relationship fluff (\"build rapport\", \"建立信任\"), " +
  "and never propose something the facts show is already settled." +
  JSON_MODE_INSTRUCTION;

/** Three things worth walking out with — the only field the user still picks. */
export async function suggestGoals(opts: {
  settings: Settings;
  facts: PrepFacts;
}): Promise<string[]> {
  const { settings, facts } = opts;
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    schema: goalsSchema,
    system: GOALS_SYSTEM + outputLanguageInstruction(settings),
    prompt: grounding(settings, facts),
  });
  void recordLlmUsage(settings, "realtime", "prep-goals", usage);
  const goals = object.goals.map((g) => g.trim()).filter(Boolean).slice(0, 3);
  log.info("ai.prep: goals", { company: facts.company.name, n: goals.length });
  return goals;
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
  "You are writing ME's plan for ONE upcoming call, from the account facts and the conversation " +
  "you just had with ME. Produce a sequenced play, not a flat list: `idealPath` is how the call " +
  "goes when it goes WELL, in order, each move with one line of why. `edgeCases` are the specific " +
  "moments it goes sideways — the trigger stated as something the other side actually does or says, " +
  "and the counter-move stated as something ME actually says or does. `agenda` items are checkable: " +
  "after the call it must be obvious whether each was got.\n\n" +
  "CRITICAL — `batna` and `floor`: fill these ONLY when the facts or the conversation genuinely " +
  "support them. If ME has never established a real walk-away alternative or a real bottom line, " +
  "return an empty string. A plausible-sounding invented BATNA is worse than a blank one: it feeds " +
  "the live negotiation analysis and would score the whole call against a fiction.\n\n" +
  "Respect the red lines absolutely — never plan a move that reveals one." +
  JSON_MODE_INSTRUCTION;

/** Turn the account facts + the conversation into the plan the user reviews. */
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
    company: facts.company.name,
    agenda: plan.agenda.length,
    path: plan.idealPath.length,
    edges: plan.edgeCases.length,
    batna: !!plan.batna,
  });
  return plan;
}
