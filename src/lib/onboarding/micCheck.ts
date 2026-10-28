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

/** Words that end a Chinese job title rather than a name (設計師, 經理, 店長…). */
const TITLE_ENDINGS = /[師長理員監裁者生工手]$/u;

/**
 * The company and the speaker's name from the check's own script ("我是
 * {company} 的 {name / title}…", "I'm {name / title} at {company}…"), for when
 * there is no model to ask. The company is whatever stands in its blank. The
 * name/title blank keeps only what looks like a name: a capitalised Latin word,
 * or a short Chinese one that doesn't end like a title.
 */
export function parseIntroScript(text: string): { company: string; name: string } {
  const zh = /我是\s*(.+?)\s*的\s*([^，,。.]+)/u.exec(text);
  const en = /\bI(?:'| a)m\s+(.+?)\s+at\s+([^,.;]+)/iu.exec(text);
  const company = (zh?.[1] ?? en?.[2] ?? "").trim();
  const who = zh?.[2] ?? en?.[1] ?? "";
  const name =
    who
      .split(/[\s/／、,，]+/u)
      .map((w) => w.trim())
      .find((w) => /^\p{Lu}[\p{L}'-]*$/u.test(w) || (/^\p{Script=Han}{2,4}$/u.test(w) && !TITLE_ENDINGS.test(w))) ?? "";
  return { company: [...company].length <= MAX_TERM_CHARS ? company : "", name };
}

/**
 * The introduction with its company and name always among the terms: what the
 * model found, else what the script's blanks held — so the dictionary learns
 * both even without an AI provider, and even when Settings already has a name.
 */
export function completeIntro(intro: IntroSummary, transcript: string): IntroSummary {
  const parsed = parseIntroScript(transcript);
  const company = intro.company || parsed.company;
  const name = intro.name || parsed.name;
  const terms = [...intro.terms];
  for (const term of [company, name]) {
    if (term && !terms.includes(term)) terms.push(term);
  }
  return { ...intro, company, name, terms };
}

/** The longest text offered as a term: a name, not a sentence. */
export const MAX_TERM_CHARS = 16;

/** Punctuation that splits clauses, so a name never contains it. */
const CLAUSE_BREAK = /[，。、；：！？,;:!?]/u;

/**
 * What a selection or an edit in the speaker background would add as a term,
 * or null when it isn't one: one line, a name's length, no clause break inside
 * (that is a sentence), not just punctuation or digits, and without the
 * punctuation around it.
 */
export function termCandidate(text: string): string | null {
  const term = text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  if (!term || /\n/u.test(term) || [...term].length > MAX_TERM_CHARS) return null;
  if (CLAUSE_BREAK.test(term) || !/\p{L}/u.test(term)) return null;
  return term;
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

/**
 * Characters that join words in a Chinese sentence rather than belong to a
 * name (常和東森談…, 派斯科技的設計師), where an edited word is taken to end.
 * Kept to the plainly grammatical: 中, 上, 大 and the like are left out, since
 * names use them (中華電信, 台灣大哥大).
 */
const ZH_JOINERS = new Set([..."的和與跟及或在是為用來談把被從到對向給讓我你他她也都就並而等"]);
const HAN = /\p{Script=Han}/u;
const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;

/**
 * The whole word an edit landed in, as it is now (`to`) and as it was
 * (`from`): fixing one character of 東昇 makes 東森, not 森. A Latin word runs
 * to the next space or punctuation; a Chinese one across Han characters up to
 * punctuation, a space, a Latin letter or a joining word (ZH_JOINERS). Null
 * when the edit didn't touch a word (only spaces or punctuation changed).
 */
export function editedWord(before: string, after: string): { from: string; to: string } | null {
  const span = changedSpan(before, after);
  const a = [...before];
  const b = [...after];
  // Where the changed text sits in `after`: after the shared start.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = start + [...span.to].length;
  const isWord = (ch: string | undefined, han: boolean) =>
    ch !== undefined && (han ? HAN.test(ch) && !ZH_JOINERS.has(ch) : WORD_CHAR.test(ch) && !HAN.test(ch));
  const anyWord = (ch: string) => isWord(ch, true) || isWord(ch, false);

  const typed = b.slice(start, end);
  const first = typed.findIndex(anyWord);
  let han: boolean;
  if (first >= 0) {
    // Narrow to the word characters typed (「、台哥大」 → 台哥大).
    const last = typed.length - 1 - [...typed].reverse().findIndex(anyWord);
    han = HAN.test(typed[first]);
    end = start + last + 1;
    start += first;
  } else {
    // Nothing word-like typed: a deletion inside a word counts, a change of
    // punctuation, spaces or a joining word doesn't.
    if (![...span.from].some(anyWord)) return null;
    const beside = b[start - 1] ?? b[start] ?? "";
    han = HAN.test(beside);
  }
  let ws = start;
  let we = end;
  while (isWord(b[ws - 1], han)) ws -= 1;
  while (isWord(b[we], han)) we += 1;
  const to = b.slice(ws, we).join("");
  if (!to) return null;
  // The word as it was: the same surroundings around what the edit replaced.
  const from = b.slice(ws, start).join("") + span.from + b.slice(end, we).join("");
  return { from, to };
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
