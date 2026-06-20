import { generateText } from "ai";
import { getModel, getProviderOptions } from "./provider";
import { recordLlmUsage } from "../usage/log";
import type { FindingMove, Settings, WargameBranchTurn, WargameStrategyKind } from "../types";

const KIND_LABEL: Record<WargameStrategyKind, string> = {
  rebut: "rebut the logic head-on",
  reframe: "refuse / reframe a smuggled premise",
  trade: "trade other leverage instead of arguing the logic",
  concede_redirect: "concede the small point and redirect",
};

const SIMULATE_SYSTEM = `You are roleplaying THEM, the opponent, in a live negotiation/interview. You are tough, self-interested, and realistic — you defend your position, probe for weakness, and don't fold easily, but you stay in character and on-topic.

You will be given the situation, the counter-move ME chose, and the exchange so far. Reply IN CHARACTER as THEM with a single natural turn — your next line in the conversation, as you'd actually say it — then stop. Do not narrate, do not break character, do not write ME's lines, do not add stage directions or analysis. Respond in the same language as the situation.`;

/**
 * Simulate ONE opponent turn for a chosen corrective move. The solution
 * drilldown drives the loop: it appends ME's reply and calls again to advance
 * the branch. Returns the new turn(s) to append (one THEM turn per call).
 */
export async function simulateBranch(opts: {
  settings: Settings;
  /** The moment being war-gamed — what THEM did / the finding being addressed. */
  situation: string;
  /** The verbatim quote it's grounded in, when one exists. */
  sourceQuote?: string;
  /** The corrective move ME chose to play out. */
  move: FindingMove;
  history: WargameBranchTurn[];
  userReply?: string;
  meetingContext?: string;
}): Promise<WargameBranchTurn[]> {
  const { settings, situation, sourceQuote, move, history, userReply, meetingContext } = opts;

  const ctxLine = meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "";

  const transcriptOfBranch = history
    .map((turn) => `${turn.role === "me" ? "ME" : "THEM"}: ${turn.text}`)
    .join("\n");

  const setup =
    `${ctxLine}The situation: ${situation}` +
    (sourceQuote ? `\n(THEM said: "${sourceQuote}")` : "") +
    `\n\nME's chosen move — ${KIND_LABEL[move.kind]}:\n${move.approach}\n\n`;

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
    : "Open as THEM: react in character to ME's move with your next single line.";

  const { text, usage } = await generateText({
    model: getModel(settings, "ask"),
    providerOptions: getProviderOptions(settings, "ask"),
    system: SIMULATE_SYSTEM,
    prompt: `${setup}${pending}${instruction}`,
  });
  void recordLlmUsage(settings, "ask", "ask", usage);

  newTurns.push({ role: "them", text: text.trim() });
  return newTurns;
}
