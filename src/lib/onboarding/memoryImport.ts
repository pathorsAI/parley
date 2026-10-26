/**
 * Onboarding's context step: turn what the user's AI assistants already
 * remember about them into speaker-background lines (settings.userBackground,
 * read by every meeting prompt via profileContext) and dictionary terms.
 *
 * Two sources, both started by the user:
 * - Claude Code: its memory files on this machine (read_claude_memory).
 * - ChatGPT: no API exposes its memory, so the user asks ChatGPT with
 *   the `onboarding.context.chatgptPrompt` text and pastes the answer back.
 *
 * Either way the raw text goes to the user's own LLM (realtime lane) and only
 * the distilled lines come back; nothing is saved until the user sees them.
 */
import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { outputLanguageInstruction } from "../ai/profile";
import { recordLlmUsage } from "../usage/log";
import type { MemoryFile } from "../ipc/commands";
import type { Settings } from "../types";

/** The prompt cap: memory is notes, and the model only needs the gist. */
export const MAX_MEMORY_CHARS = 24_000;
/** Lines kept from one pass, so a chatty memory can't flood the background. */
export const MAX_BACKGROUND_LINES = 8;
export const MAX_TERMS = 12;

const schema = z.object({
  background: z.array(z.string()).default([]),
  terms: z.array(z.string()).default([]),
});

export interface MemorySummary {
  background: string[];
  terms: string[];
}

const SYSTEM =
  "You read notes an AI assistant has kept about its user and extract what a meeting assistant " +
  "should know about that user going into their meetings.\n" +
  "Return JSON with two arrays:\n" +
  `- "background": at most ${MAX_BACKGROUND_LINES} short, factual lines about the user: their role and ` +
  "company, what they work on, the customers or partners they meet, their team members and roles, and " +
  "how they like to work. One fact per line, no bullet characters, no line over 80 characters.\n" +
  `- "terms": at most ${MAX_TERMS} proper nouns a speech recogniser would likely get wrong: company, ` +
  "product, project and people names. Exactly as written in the notes.\n" +
  "Skip coding conventions, tool configuration, file paths, secrets, credentials and anything about " +
  "other people's private lives. If the notes say nothing useful, return empty arrays.\n";

/** Claude Code memory files as one prompt body, each under its label, capped. */
export function memoryFilesToText(files: readonly MemoryFile[]): string {
  return capMemoryText(files.map((f) => `## ${f.label}\n${f.text.trim()}`).join("\n\n"));
}

export function capMemoryText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_MEMORY_CHARS ? trimmed.slice(0, MAX_MEMORY_CHARS) : trimmed;
}

/** Distil memory text into background lines and terms with the user's LLM. */
export async function summarizeMemory(opts: {
  settings: Settings;
  text: string;
  signal?: AbortSignal;
}): Promise<MemorySummary> {
  const { settings, text, signal } = opts;
  const body = capMemoryText(text);
  if (!body) return { background: [], terms: [] };
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `NOTES:\n${body}`,
    signal,
  });
  void recordLlmUsage(settings, "realtime", "memory-import", usage);
  return {
    background: cleanLines(object.background).slice(0, MAX_BACKGROUND_LINES),
    terms: cleanLines(object.terms).slice(0, MAX_TERMS),
  };
}

/** Trimmed, de-bulleted, non-empty, de-duplicated lines. */
export function cleanLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*(?:[-*•‧·]|\d+[.)])\s*/u, "").trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/** settings.userBackground as editable lines (one fact per line). */
export function backgroundLines(background: string): string[] {
  return cleanLines(background.split(/\r?\n/u));
}

/** Lines back into settings.userBackground. */
export function joinBackground(lines: readonly string[]): string {
  return cleanLines(lines).join("\n");
}

/** Append new lines the background doesn't already have. */
export function mergeBackground(background: string, add: readonly string[]): string {
  return joinBackground([...backgroundLines(background), ...add]);
}
