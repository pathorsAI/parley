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
import { addEntry, applyReplacements, listEntries, whenDictionaryReady } from "../dictionary";
import { cleanLines, removeBackgroundLines } from "./memoryImport";

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

/**
 * The product's name, which the check's script has the user say. The check is
 * the first thing Parley ever transcribes for them, so it must not get its own
 * name wrong: the recognizer is told the word up front (`withProductName`),
 * and whatever it still mishears is rewritten (`fixProductName`).
 */
export const PRODUCT_NAME = "Parley";

/**
 * How recognizers mishear "Parley", in English and as Chinese sound-alikes.
 * Safe to rewrite unconditionally here — and only here: in a self-introduction
 * that reads "I use Parley to…" these can only mean the product, while in an
 * ordinary meeting 帕利 or "parlay" may well be what was said. Words that are
 * plausible names in an introduction (Harley, parlor) are left alone.
 * Traditional forms only: the transcript is converted before this runs.
 */
const PRODUCT_NAME_MISHEARINGS = [
  "parley", // the right word in the wrong case
  "parlay",
  "parlee",
  "parly",
  "parlie",
  "parle",
  "parli",
  "parlei",
  "parleigh",
  "parlé",
  "barley",
  "par lay",
  "par ley",
  "par lee",
  "pa ley",
  "pah ley",
  "帕雷",
  "帕利",
  "帕里",
  "帕莉",
  "帕麗",
  "帕力",
  "帕立",
  "帕勒",
  "帕來",
  "帕萊",
  "趴雷",
  "趴利",
  "啪雷",
  "派雷",
  "派利",
  "派力",
  "怕累",
  "怕雷",
  "巴雷",
];

const PRODUCT_NAME_ENTRY = [
  { id: "builtin-product-name", phrase: PRODUCT_NAME, variants: PRODUCT_NAME_MISHEARINGS, createdAt: 0, source: "manual" as const },
];

/** The check's recognition terms with the product's name first. */
export function withProductName(vocabulary: readonly string[]): string[] {
  return [PRODUCT_NAME, ...vocabulary.filter((term) => term !== PRODUCT_NAME)];
}

/** Rewrite every mishearing of the product's name, spaced off from Chinese the way the script writes it. */
export function fixProductName(text: string): string {
  return applyReplacements(text, PRODUCT_NAME_ENTRY)
    .replace(/(\p{Script=Han})Parley/gu, "$1 Parley")
    .replace(/Parley(\p{Script=Han})/gu, "Parley $1");
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
  /** This call made the entry (it wasn't in the dictionary before). */
  created?: boolean;
}

type ProfileFields = Pick<Settings, "userName" | "userCompany" | "userRole">;

/**
 * What one check put into the user's setup, so that testing again replaces
 * it instead of piling a second introduction on top: the background lines it
 * appended, the profile fields it filled, the dictionary entries it created
 * (deleted on undo) and every term it listed (taken off the context step's list).
 */
export interface MicRun {
  lines: string[];
  profile: Partial<ProfileFields>;
  created: string[];
  terms: string[];
}

/**
 * The settings half of undoing a run: its background lines out, and the
 * profile fields it filled cleared — unless the user has since changed them,
 * in which case they are theirs now.
 */
export function undoMicRun(
  settings: Pick<Settings, "userBackground"> & ProfileFields,
  run: MicRun,
): Partial<Pick<Settings, "userBackground"> & ProfileFields> {
  const patch: Partial<Pick<Settings, "userBackground"> & ProfileFields> = {
    userBackground: removeBackgroundLines(settings.userBackground, run.lines),
  };
  for (const key of Object.keys(run.profile) as (keyof ProfileFields)[]) {
    if (settings[key] === run.profile[key]) patch[key] = "";
  }
  return patch;
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
    if (id && !out.some((t) => t.id === id)) out.push({ id, phrase, created: res?.kind === "entry" });
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

/**
 * The user corrected a name in their speaker background (`from` → `to`, see
 * detectCorrection): add `to` to the dictionary with the old spelling as a
 * variant, so transcription writes it the corrected way, and return its entry.
 */
export async function learnTerm(from: string, to: string): Promise<AddedTerm | null> {
  await whenDictionaryReady();
  const res = addEntry({ phrase: to, variants: [from], source: "correction" });
  const id = res?.entryId ?? listEntries().find((e) => e.phrase === to.trim())?.id;
  return id ? { id, phrase: to.trim() } : null;
}

/** The longest edit (either side) worth asking the model about: a name, not a rewrite. */
const MAX_NAME_EDIT = 24;

/** What differs between two texts once their shared start and end are removed (code points). */
export function changedSpan(before: string, after: string): { from: string; to: string } {
  const a = [...before];
  const b = [...after];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { from: a.slice(start, endA).join(""), to: b.slice(start, endB).join("") };
}

const nameEditSchema = z.object({ from: z.string().default(""), to: z.string().default("") });

const NAME_EDIT_SYSTEM =
  "The user edited a short text about themself. You get it before and after. If the edit corrected or " +
  "completed a name (a company, a person or a product), return the whole name as it was before (\"from\") " +
  "and as it is now (\"to\"), e.g. 東昇 → 東森. Otherwise, or if the edit added or removed other words, " +
  'return empty strings.\n';

/**
 * The name the user corrected, for edits the dictation rule (detectCorrection)
 * can't place: Chinese has no word boundaries, so a one-character fix (東昇 →
 * 東森) or an added character (台灣大哥 → 台灣大哥大) leaves it without the
 * whole name. Only small edits are asked about, and only with an AI provider;
 * the answer must be a name that is actually in the new text.
 */
export async function findNameEdit(opts: {
  settings: Settings;
  before: string;
  after: string;
  signal?: AbortSignal;
}): Promise<{ from: string; to: string } | null> {
  const { settings, before, after, signal } = opts;
  const span = changedSpan(before, after);
  if (!span.to || [...span.from].length > MAX_NAME_EDIT || [...span.to].length > MAX_NAME_EDIT) return null;
  if (!isProviderReady(settings, "realtime")) return null;
  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    feature: "meeting",
    schema: nameEditSchema,
    system: NAME_EDIT_SYSTEM + JSON_MODE_INSTRUCTION,
    prompt: `BEFORE:\n${before}\n\nAFTER:\n${after}`,
    signal,
  });
  void recordLlmUsage(settings, "realtime", "mic-check", usage);
  const from = object.from.trim();
  const to = object.to.trim();
  if (!from || !to || from === to || !after.includes(to) || !before.includes(from)) return null;
  return { from, to };
}
