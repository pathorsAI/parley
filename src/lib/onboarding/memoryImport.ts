/**
 * Onboarding's context step: what the user's AI assistant already remembers
 * about them, condensed into a few read-only lines (settings.aiMemoryNotes,
 * read by every meeting prompt via profileContext). The source is Claude
 * Code's memory files on this machine (read_claude_memory), read when the
 * step opens; secrets are masked before the text goes to the user's own LLM
 * (realtime lane), and only the condensed lines are kept.
 *
 * The helpers for settings.userBackground (the editable speaker background)
 * live here too.
 */
import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { outputLanguageInstruction } from "../ai/profile";
import { recordLlmUsage } from "../usage/log";
import type { MemoryFile } from "../ipc/commands";
import type { Settings } from "../types";

/** The prompt cap: memory is notes, and the model only needs the gist. The
 *  Rust reader stops at the same size (whole files only), so this is only a
 *  backstop. */
export const MAX_MEMORY_CHARS = 24_000;
/** What stands in for a redacted secret. */
export const REDACTED = "[redacted]";
/** Lines kept, so a chatty memory reads as a summary, not a dump. */
export const MAX_MEMORY_LINES = 8;
/** Names kept for the dictionary. */
export const MAX_MEMORY_TERMS = 12;

const schema = z.object({
  notes: z.array(z.string()).default([]),
  terms: z.array(z.string()).default([]),
});

export interface MemorySummary {
  notes: string[];
  /** Company, people and product names, for the dictionary. */
  terms: string[];
}

const SYSTEM =
  "You read notes an AI assistant has kept about its user and extract what a meeting assistant " +
  "should know about that user going into their meetings.\n" +
  "Return JSON with two arrays:\n" +
  `- "notes": at most ${MAX_MEMORY_LINES} short, factual lines about the user: their role and company, ` +
  "what they work on and know, the customers or partners they meet, their team members and roles, and how " +
  "they like to work. One fact per line, no bullet characters, no line over 80 characters.\n" +
  `- "terms": at most ${MAX_MEMORY_TERMS} names a speech recogniser would likely get wrong: company names ` +
  "(their own, customers', partners'), people's names and product names. Exactly as written in the notes, " +
  "one name per entry, no descriptions.\n" +
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

/** Condense memory text into a few lines, and the names in it, with the user's LLM. */
export async function summarizeMemory(opts: {
  settings: Settings;
  text: string;
  signal?: AbortSignal;
}): Promise<MemorySummary> {
  const { settings, text, signal } = opts;
  const body = capMemoryText(redactSecrets(text));
  if (!body) return { notes: [], terms: [] };
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
    notes: cleanLines(object.notes).slice(0, MAX_MEMORY_LINES),
    terms: cleanLines(object.terms).slice(0, MAX_MEMORY_TERMS),
  };
}

/**
 * Mask what looks like a credential before memory text leaves the machine: the
 * prompt asks the model to skip secrets, but by then they've been sent. Catches
 * well-known token prefixes, `key = value` assignments with a secret-ish name,
 * and long unbroken key-like runs; prose is left alone.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}/gu,
      REDACTED,
    )
    .replace(
      /\b([A-Za-z_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z_]*)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/giu,
      (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
    )
    // A long run of key characters with digits in it (paths and words have none
    // that long, or no digits).
    .replace(/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/gu, REDACTED);
}

/** A list marker at the start of a line: a bullet, or "1." / "2)" followed by a
 *  space. Digits glued to the text ("3.5 years") and a minus or asterisk with no
 *  space after it ("-10%", "*Important*") are content, not markers. */
const LIST_MARKER = /^\s*(?:[•‧·]\s*|[-*+]\s+|\d{1,2}[.)]\s+)/u;

/** The model's output as clean lines: trimmed, de-bulleted, non-empty, unique. */
export function cleanLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(LIST_MARKER, "").trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * settings.userBackground is free text the user may also edit in Settings ›
 * Basic Settings, with their own bullets, indentation and blank lines. The
 * helpers below read it as lines and append to it, never re-formatting what
 * is already there.
 */

/** The background's non-blank lines, for display (trimmed, markers kept). */
export function backgroundLines(background: string): string[] {
  return background
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Append the lines the background doesn't already have (compared without
 *  list markers); returns the new text and how many lines were added. */
export function appendBackground(background: string, add: readonly string[]): { text: string; added: number } {
  const have = new Set(cleanLines(backgroundLines(background)));
  const fresh = cleanLines(add).filter((l) => !have.has(l));
  if (fresh.length === 0) return { text: background, added: 0 };
  const base = background.replace(/\s+$/u, "");
  return { text: (base ? `${base}\n` : "") + fresh.join("\n"), added: fresh.length };
}
