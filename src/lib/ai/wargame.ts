import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { transcriptAsText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
import { profileContext } from "./profile";
import type {
  Settings,
  TranscriptSegment,
  WargameArgument,
  WargameBranchTurn,
  WargameStrategy,
} from "../types";

// --- detectArguments ---------------------------------------------------------

const strategySchema = z.object({
  kind: z
    .enum(["rebut", "reframe", "trade", "concede_redirect"])
    .describe(
      "rebut = attack the logic head-on; reframe = refuse/reframe a smuggled premise; " +
        "trade = don't argue the logic, offer or extract other leverage instead (negotiation); " +
        "concede_redirect = grant the small point, then pivot to what matters."
    ),
  approach: z
    .string()
    .describe("A concrete move ME can make at the table — phrased as something ME could actually say or do."),
  predictedReaction: z
    .string()
    .describe("Realistic prediction of how THEM (a tough opponent) counters or responds to this angle."),
});

const argumentSchema = z.object({
  id: z.string().describe("A short unique id for this argument."),
  claim: z.string().describe("THEM's argument, stated in their own framing."),
  sourceQuote: z
    .string()
    .describe("A short verbatim quote from THEM that this argument is grounded in. Empty string if none."),
  premises: z
    .array(z.string())
    .describe("The hidden premises this claim relies on / smuggles in — the things ME would be tacitly accepting."),
  trap: z
    .object({
      premise: z.string().describe("The premise that looks acceptable but should NOT be conceded."),
      why: z.string().describe("Why conceding it quietly hands THEM the win."),
    })
    .nullable()
    .describe("The single most dangerous premise to guard against, or null if none stands out."),
  strategies: z
    .array(strategySchema)
    .describe("Response angles, spanning the four kinds where sensible (don't force kinds that don't fit)."),
});

const detectSchema = z.object({ arguments: z.array(argumentSchema) });

const DETECT_SYSTEM = `You are the war-gaming engine for Parley, a realtime meeting copilot. You assist the user ("ME") in a live negotiation, interview, or sales conversation against the other party ("THEM").

Your job: read the transcript and surface the KEY ARGUMENTS that THEM are advancing — the claims THEM use to win ground, lower price, dodge a commitment, or shift obligation onto ME. Then, for each, arm ME to respond well.

Hard rules:
- Only analyze arguments actually made by THEM. Never analyze ME's own points.
- Ground every claim and sourceQuote in what was genuinely said. Never invent or paraphrase quotes into the sourceQuote field — quote THEM verbatim, or leave it empty.
- Pick the few arguments that actually matter (typically 1–4). Skip small talk and throwaway remarks.

For each argument:
- premises: expose the HIDDEN premises the claim smuggles in — the assumptions ME would be tacitly accepting just by engaging on THEM's terms.
- trap: this is the headline value. Identify the ONE premise that sounds fair and reasonable but should NOT be conceded, because quietly accepting it hands THEM the outcome. Explain why in "why". If genuinely none stands out, set trap to null — don't force it.
- strategies: give MULTIPLE angles, not one. Where each fits, include:
    * rebut — attack the logic directly.
    * reframe — refuse or reframe a smuggled premise rather than arguing inside it.
    * trade — DON'T fight the logic head-on; instead use negotiation leverage (offer something, or ask for something in return, or change what's on the table). This is often the strongest move when the logic is actually sound.
    * concede_redirect — grant the minor point, then pivot to what really matters.
  For each strategy give a concrete "approach" (something ME could actually say/do) and a realistic "predictedReaction" (how a tough, self-interested THEM would respond).

Respond ENTIRELY in the language of the transcript (e.g. if THEM speak Traditional Chinese, write claims, premises, traps, and strategies in Traditional Chinese). Business-negotiation claims are common — e.g. a distributor arguing it "has no obligation to disclose to the manufacturer the price it sold at". Treat such claims seriously: the trap is usually a smuggled premise about what is owed to whom.`;

/**
 * Auto-detect THEM's key arguments from the transcript and, for each, decompose
 * the premises, flag the premise not to concede, and propose multiple response
 * angles each with a predicted reaction.
 */
export async function detectArguments(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  meetingContext?: string;
  names?: Record<string, string>;
}): Promise<WargameArgument[]> {
  const { settings, segments, meetingContext, names } = opts;
  const transcript = transcriptAsText(segments, names);
  if (!transcript.trim()) return [];

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");

  log.info("ai.wargame.detect: start", {
    provider: settings.provider,
    model: settings.models[settings.provider].eval,
    segments: segments.length,
  });

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema: detectSchema,
    system: DETECT_SYSTEM + JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Transcript so far:\n${transcript}\n\nDetect THEM's key arguments and war-game each.`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  log.info("ai.wargame.detect: ok", { arguments: object.arguments.length });

  return object.arguments.map((a) => ({
    id: a.id?.trim() || crypto.randomUUID(),
    claim: a.claim,
    sourceQuote: a.sourceQuote?.trim() ? a.sourceQuote.trim() : undefined,
    premises: a.premises ?? [],
    trap: a.trap ?? null,
    strategies: (a.strategies ?? []) as WargameStrategy[],
  }));
}

// --- simulateBranch ----------------------------------------------------------

const KIND_LABEL: Record<WargameStrategy["kind"], string> = {
  rebut: "rebut the logic head-on",
  reframe: "refuse / reframe a smuggled premise",
  trade: "trade other leverage instead of arguing the logic",
  concede_redirect: "concede the small point and redirect",
};

const SIMULATE_SYSTEM = `You are roleplaying THEM, the opponent, in a live negotiation/interview. You are tough, self-interested, and realistic — you defend your position, probe for weakness, and don't fold easily, but you stay in character and on-topic.

You will be given THEM's original argument, the counter-strategy ME chose, and the exchange so far. Reply IN CHARACTER as THEM with a single natural turn — your next line in the conversation, as you'd actually say it — then stop. Do not narrate, do not break character, do not write ME's lines, do not add stage directions or analysis. Respond in the same language as the original argument.`;

/**
 * Simulate ONE opponent turn for a chosen counter-strategy branch. The panel
 * drives the loop: it appends ME's reply and calls again to advance the branch.
 * Returns the new turn(s) to append (one THEM turn per call).
 */
export async function simulateBranch(opts: {
  settings: Settings;
  argument: WargameArgument;
  strategy: WargameStrategy;
  history: WargameBranchTurn[];
  userReply?: string;
  meetingContext?: string;
}): Promise<WargameBranchTurn[]> {
  const { settings, argument, strategy, history, userReply, meetingContext } = opts;

  const ctxLine = meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "";

  const transcriptOfBranch = history
    .map((turn) => `${turn.role === "me" ? "ME" : "THEM"}: ${turn.text}`)
    .join("\n");

  const setup =
    `${ctxLine}THEM's original argument: "${argument.claim}"` +
    (argument.sourceQuote ? `\n(Originally said: "${argument.sourceQuote}")` : "") +
    `\n\nME's chosen counter-strategy — ${KIND_LABEL[strategy.kind]}:\n${strategy.approach}\n\n`;

  const exchange = transcriptOfBranch
    ? `Exchange so far:\n${transcriptOfBranch}\n\n`
    : "This is the start of the exchange.\n\n";

  // ME's latest reply (when continuing the branch) is the line THEM must answer.
  const newTurns: WargameBranchTurn[] = [];
  let pending = exchange;
  if (userReply?.trim()) {
    newTurns.push({ role: "me", text: userReply.trim() });
    pending += `ME just said: "${userReply.trim()}"\n\n`;
  }

  const instruction = transcriptOfBranch
    ? "Continue as THEM: give your next single line in reply."
    : "Open as THEM: react in character to ME's counter-strategy with your next single line.";

  log.info("ai.wargame.sim: start", {
    provider: settings.provider,
    model: settings.models[settings.provider].ask,
    historyTurns: history.length,
  });

  const { text, usage } = await generateText({
    model: getModel(settings, "ask"),
    providerOptions: getProviderOptions(settings, "ask"),
    system: SIMULATE_SYSTEM,
    prompt: `${setup}${pending}${instruction}`,
  });
  void recordLlmUsage(settings, "ask", "ask", usage);

  log.info("ai.wargame.sim: ok", { chars: text.trim().length });

  newTurns.push({ role: "them", text: text.trim() });
  return newTurns;
}
