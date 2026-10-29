/**
 * Onboarding's context step, "how you work": what Claude Code on this machine
 * already knows about the user (read_claude_memory) is folded into their
 * speaker background (settings.userBackground), which every meeting prompt
 * reads. The user's LLM (realtime lane) reads the background they gave in
 * the mic check — company, title, what they use Parley for — and adds what
 * the files say under it, a line per section of a fixed template; the user
 * can edit it after.
 * Secrets are masked before any text leaves the machine.
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

/** The prompt cap. The Rust reader returns up to 24k characters, but the
 *  hosted model's proxy sits on a small per-minute token budget, and a prompt
 *  that size (CJK runs about a token a character) came back as 502 every
 *  time. The facts worth having are near the top of each file. */
export const MAX_MEMORY_CHARS = 6_000;
/** What stands in for a redacted secret. */
export const REDACTED = "[redacted]";
/** Names kept for the dictionary. */
export const MAX_MEMORY_TERMS = 12;

/**
 * The speaker background's sections, in order. Each becomes one
 * "label：facts" line; sections with nothing to say are left out.
 */
export const BACKGROUND_TEMPLATE = {
  "zh-TW": ["身分", "公司", "用 Parley 做什麼", "負責的工作", "常開的會議", "常見講者", "溝通偏好"],
  en: ["Who I am", "Company", "Using Parley for", "What I work on", "Usual meetings", "Frequent speakers", "How I like to work"],
} as const;

/** The template's labels in the app's language. */
export function backgroundLabels(settings: Pick<Settings, "language">): readonly string[] {
  return BACKGROUND_TEMPLATE[settings.language === "zh-TW" ? "zh-TW" : "en"];
}

// Both required, no `.default()`: see micCheck.ts — optional fields in a strict
// json_schema come back from the hosted model as 502.
export const backgroundDraftSchema = z.object({
  background: z.array(z.string()),
  terms: z.array(z.string()),
});

export interface BackgroundDraft {
  /** Lines to add under the speaker background, one template section each. */
  background: string[];
  /** Company, people and product names, for the dictionary. */
  terms: string[];
}

function system(labels: readonly string[]): string {
  return (
    "You write the speaker background a meeting assistant reads before every meeting: who the user is, " +
    "so it can tell which speaker is them and advise from their side.\n" +
    "You get the background the user already gave (CURRENT: their self-introduction, may be empty) and " +
    "notes their coding assistant keeps about them (NOTES). CURRENT stays as it is; you write what goes " +
    "under it.\n" +
    'Return JSON with two arrays:\n' +
    '- "background": what NOTES add that CURRENT doesn\'t already say, one line per section below, in this ' +
    'order, each written as "<label>：<facts>" with the label exactly as given. Put several facts in one ' +
    "line separated by \"；\". Leave out a section when NOTES add nothing to it. Never contradict CURRENT. " +
    "Only what helps in meetings; no line over 120 characters.\n" +
    `  Sections: ${labels.map((l) => `"${l}"`).join(", ")}.\n` +
    `- "terms": at most ${MAX_MEMORY_TERMS} names a speech recogniser would likely get wrong: company names ` +
    "(their own, customers', partners'), people's names and product names. Exactly as written, one name " +
    "per entry, no descriptions.\n" +
    "Skip coding conventions, tool configuration, file paths, secrets, credentials and anything about " +
    "other people's private lives.\n"
  );
}

/**
 * Claude Code memory files as one prompt body, each under its label, within
 * MAX_MEMORY_CHARS shared fairly: short files whole, and what they leave split
 * evenly among the long ones, each cut to its start — so one long global file
 * can't crowd out the short notes after it.
 */
export function memoryFilesToText(files: readonly MemoryFile[]): string {
  const texts = files.map((f) => f.text.trim());
  const heads = files.map((f) => `## ${f.label}\n`);
  const share = new Map<number, number>();
  // The labels and the blank lines between files come out of the budget first.
  let left = MAX_MEMORY_CHARS - heads.reduce((n, h) => n + h.length + 2, 0);
  const bySize = texts.map((_text, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  bySize.forEach((i, k) => {
    const fair = Math.max(0, Math.floor(left / (bySize.length - k)));
    const take = Math.min(texts[i].length, fair);
    share.set(i, take);
    left -= take;
  });
  return capMemoryText(
    heads.map((head, i) => head + texts[i].slice(0, share.get(i))).join("\n\n"),
  );
}

export function capMemoryText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_MEMORY_CHARS ? trimmed.slice(0, MAX_MEMORY_CHARS) : trimmed;
}

/**
 * What the notes add to the speaker background, as template lines to go
 * under it, and the names in them, by the user's LLM. Lines that don't start
 * with a template label are dropped, so the addition always reads as the
 * template.
 */
export async function draftBackground(opts: {
  settings: Settings;
  /** The background as it stands. */
  current: string;
  /** Memory text (memoryFilesToText). */
  text: string;
  signal?: AbortSignal;
}): Promise<BackgroundDraft> {
  const { settings, current, text, signal } = opts;
  const body = capMemoryText(redactSecrets(text));
  if (!body) return { background: [], terms: [] };
  const labels = backgroundLabels(settings);
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema: backgroundDraftSchema,
    system: system(labels) + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `CURRENT:\n${redactSecrets(current.trim()) || "(empty)"}\n\nNOTES:\n${body}`,
    signal,
  });
  void recordLlmUsage(settings, "realtime", "memory-import", usage);
  return {
    background: templateLines(object.background, labels),
    terms: cleanLines(object.terms).slice(0, MAX_MEMORY_TERMS),
  };
}

/**
 * The model's background lines kept to the template: each must open with one
 * of `labels` and a colon (either width), is normalised to "label：facts", and
 * they come back in template order, one per label.
 */
export function templateLines(lines: readonly string[], labels: readonly string[]): string[] {
  const byLabel = new Map<string, string>();
  for (const line of cleanLines(lines)) {
    const label = labels.find((l) => line.startsWith(l));
    if (!label) continue;
    const rest = line.slice(label.length).trim();
    if (!/^[:：]/u.test(rest)) continue;
    const facts = rest.slice(1).trim();
    if (facts && !byLabel.has(label)) byLabel.set(label, facts);
  }
  return labels.filter((l) => byLabel.has(l)).map((l) => `${l}：${byLabel.get(l)}`);
}

/** One line of the context step's reading log. */
export type ReadingStep = { kind: "file"; name: string } | { kind: "auto"; count: number };

/**
 * What the context step says it read, in reading order: each file by name,
 * except Claude Code's auto memory (often dozens of small files), which is one
 * line with a count where its first file was.
 */
export function readingSteps(files: readonly MemoryFile[]): ReadingStep[] {
  const out: ReadingStep[] = [];
  let auto: { kind: "auto"; count: number } | null = null;
  for (const f of files) {
    if (f.kind === "auto") {
      if (auto) auto.count += 1;
      else out.push((auto = { kind: "auto", count: 1 }));
    } else {
      out.push({ kind: "file", name: f.name });
    }
  }
  return out;
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
 *  list markers); returns the new text, how many lines were added and which. */
export function appendBackground(
  background: string,
  add: readonly string[],
): { text: string; added: number; lines: string[] } {
  const have = new Set(cleanLines(backgroundLines(background)));
  const fresh = cleanLines(add).filter((l) => !have.has(l));
  if (fresh.length === 0) return { text: background, added: 0, lines: [] };
  const base = background.replace(/\s+$/u, "");
  return { text: (base ? `${base}\n` : "") + fresh.join("\n"), added: fresh.length, lines: fresh };
}

/** Take out lines added earlier (compared without list markers), leaving the rest as written. */
export function removeBackgroundLines(background: string, lines: readonly string[]): string {
  const drop = new Set(cleanLines(lines));
  if (drop.size === 0) return background;
  return background
    .split(/\r?\n/u)
    .filter((l) => {
      const line = cleanLines([l])[0];
      return !line || !drop.has(line);
    })
    .join("\n")
    .replace(/\s+$/u, "");
}
