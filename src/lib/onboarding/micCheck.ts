/**
 * Onboarding's microphone check: the user reads a short self-introduction,
 * the configured STT provider transcribes it live (start_mic_check), and the
 * sentence becomes the first line of their speaker background — plus their
 * name and company, when Settings doesn't have them yet, and the company,
 * people and product names they said as dictionary terms.
 *
 * With an AI provider set up, the model tidies the sentence into those parts;
 * without one, the transcript itself is the background line, so the check
 * still leaves something behind.
 */
import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { outputLanguageInstruction } from "../ai/profile";
import { isProviderReady } from "../ai/settings";
import { recordLlmUsage } from "../usage/log";
import type { Settings } from "../types";
import { addEntry, listEntries, whenDictionaryReady } from "../dictionary";
import { cleanLines } from "./memoryImport";

/** The source label on the check's events (mic_check.rs `MIC_CHECK_SOURCE`). */
export const MIC_CHECK_SOURCE = "mic-check";
/** The frontend ends the check here; the backend caps it a little later. */
export const MIC_CHECK_MAX_MS = 30_000;

/**
 * The live transcript of one check: committed segments in id order, then the
 * tentative tail. Segment ids end in a running number ("mic-check-3").
 */
export class CheckTranscript {
  private readonly finals = new Map<string, string>();
  private interim = "";

  accept(seg: { id: string; source: string; text: string; is_final: boolean }): boolean {
    if (seg.source !== MIC_CHECK_SOURCE) return false;
    if (seg.is_final) {
      this.finals.set(seg.id, seg.text);
      this.interim = "";
    } else {
      this.interim = seg.text;
    }
    return true;
  }

  text(): string {
    const order = (id: string) => {
      const m = /-(\d+)$/u.exec(id);
      return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    const committed = [...this.finals.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([, t]) => t);
    return joinRuns([...committed, this.interim]);
  }
}

/** Join recognizer runs: CJK runs touch, Latin runs get a space between. */
export function joinRuns(runs: readonly string[]): string {
  let out = "";
  for (const raw of runs) {
    const run = raw.trim();
    if (!run) continue;
    const glue = out && /[A-Za-z0-9]$/u.test(out) && /^[A-Za-z0-9]/u.test(run) ? " " : "";
    out += glue + run;
  }
  return out;
}

export interface IntroSummary {
  /** Lines for settings.userBackground. */
  background: string[];
  /** Proper nouns for the dictionary. */
  terms: string[];
  name: string;
  company: string;
  role: string;
}

const schema = z.object({
  name: z.string().default(""),
  company: z.string().default(""),
  role: z.string().default(""),
  background: z.array(z.string()).default([]),
  terms: z.array(z.string()).default([]),
});

const SYSTEM =
  "The user introduced themself out loud to a meeting assistant; you get the speech-to-text " +
  "transcript, which may contain recognition errors. Return JSON:\n" +
  '- "name", "company", "role": as stated, or "" when not said.\n' +
  '- "background": 1 to 3 short factual lines about the user (who they are, what they use the ' +
  "assistant for). No bullet characters, no line over 80 characters.\n" +
  '- "terms": the names said, for a speech recogniser: company names, people\'s names (the user\'s ' +
  "included) and product names, each spelled as the user most likely writes it; one name per entry.\n" +
  "Never invent anything that wasn't said.\n";

/** Turn the transcript into background lines, terms and profile fields. */
export async function summarizeIntro(opts: {
  settings: Settings;
  transcript: string;
  signal?: AbortSignal;
}): Promise<IntroSummary> {
  const { settings, signal } = opts;
  const transcript = opts.transcript.trim();
  const plain: IntroSummary = { background: transcript ? [transcript] : [], terms: [], name: "", company: "", role: "" };
  if (!transcript || !isProviderReady(settings, "realtime")) return plain;
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema,
    system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `TRANSCRIPT:\n${transcript}`,
    signal,
  });
  void recordLlmUsage(settings, "realtime", "mic-check", usage);
  const background = cleanLines(object.background).slice(0, 3);
  return {
    background: background.length > 0 ? background : plain.background,
    terms: cleanLines(object.terms).slice(0, 8),
    name: object.name.trim(),
    company: object.company.trim(),
    role: object.role.trim(),
  };
}

/** The profile fields to fill: only the ones Settings doesn't have yet. */
export function profileFill(
  settings: Pick<Settings, "userName" | "userCompany" | "userRole">,
  intro: Pick<IntroSummary, "name" | "company" | "role">,
): Partial<Pick<Settings, "userName" | "userCompany" | "userRole">> {
  const out: Partial<Pick<Settings, "userName" | "userCompany" | "userRole">> = {};
  if (!settings.userName.trim() && intro.name) out.userName = intro.name;
  if (!settings.userCompany.trim() && intro.company) out.userCompany = intro.company;
  if (!settings.userRole.trim() && intro.role) out.userRole = intro.role;
  return out;
}

/** A dictionary entry onboarding lists as a term. */
export interface AddedTerm {
  id: string;
  phrase: string;
}

/**
 * Make sure each phrase is in the dictionary and return its entry — new or
 * already there — so the context step lists every name onboarding found, even
 * on a second run of the wizard when they all exist from the first. Removing
 * one from the list is the user asking for it gone, so it removes the entry.
 */
export async function addTerms(phrases: readonly string[]): Promise<AddedTerm[]> {
  await whenDictionaryReady();
  const out: AddedTerm[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const res = addEntry({ phrase, source: "manual" });
    const id = res?.entryId ?? listEntries().find((e) => e.phrase === phrase)?.id;
    if (id && !out.some((t) => t.id === id)) out.push({ id, phrase });
  }
  return out;
}

/** Merge terms into a list, skipping ones it already has (same entry or same phrase). */
export function mergeTerms(list: readonly AddedTerm[], add: readonly AddedTerm[]): AddedTerm[] {
  const out = [...list];
  for (const t of add) {
    if (!out.some((x) => x.id === t.id || x.phrase === t.phrase)) out.push(t);
  }
  return out;
}
