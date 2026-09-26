/**
 * Ready-made questions for handing a recording to an external AI. A blank chat
 * box is the hard part of "ask your AI about it", so every hand-off surface
 * offers three questions worth asking: `questions` travel inside the pasted
 * prompt, `mcpQuestions` are typed into Claude Code once it is connected to
 * Parley over MCP (so they name the recording and tell the agent to use Parley).
 *
 * The bundled sample recording gets questions written for its scene; any other
 * recording gets generic ones.
 */
import { translate, type TranslationKey } from "../../i18n/messages";
import type { AppLanguage } from "../types";
import { isSampleEntry } from "./sample";

export interface HandoffQuestions {
  questions: string[];
  mcpQuestions: string[];
}

const SAMPLE_KEYS = {
  questions: ["study.handoff.q.sample1", "study.handoff.q.sample2", "study.handoff.q.sample3"],
  mcpQuestions: ["study.handoff.mcp.sample1", "study.handoff.mcp.sample2", "study.handoff.mcp.sample3"],
} as const satisfies Record<keyof HandoffQuestions, readonly TranslationKey[]>;

const GENERIC_KEYS = {
  questions: ["study.handoff.q.generic1", "study.handoff.q.generic2", "study.handoff.q.generic3"],
  mcpQuestions: ["study.handoff.mcp.generic1", "study.handoff.mcp.generic2", "study.handoff.mcp.generic3"],
} as const satisfies Record<keyof HandoffQuestions, readonly TranslationKey[]>;

export function handoffQuestions(
  entry: { id: string; title: string },
  lang: AppLanguage
): HandoffQuestions {
  const keys = isSampleEntry(entry) ? SAMPLE_KEYS : GENERIC_KEYS;
  const vars = { title: entry.title.trim() };
  return {
    questions: keys.questions.map((k) => translate(lang, k, vars)),
    mcpQuestions: keys.mcpQuestions.map((k) => translate(lang, k, vars)),
  };
}
