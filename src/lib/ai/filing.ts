import { z } from "zod";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
// THE title + filing prompt every Parley client sends — desktop, iOS and
// Android. The phones read generated copies of this same file
// (scripts/gen-filing-prompt.mjs), so any wording change lands everywhere at
// once and a recording gets the same title whichever device filed it.
import FILING from "../../../shared/prompts/filing.json";
import type {
  FilingFolderSuggestion,
  FilingSuggestion,
  Settings,
  TranscriptSegment,
} from "../types";

// No .min()/.max() on the array: the JSON-mode providers we wire (Groq and the
// other openai-compatible ones) choke on count constraints, and a rejected
// schema costs us the whole pass. The 1-3 count is asked for in the prompt and
// ENFORCED in resolveFilingFolders, which has to survive a disobedient model
// anyway (cf. timeline.ts / actionItems.ts, which take the same line).
//
// No .describe() either: JSON mode embeds the schema, descriptions included, in
// what the model reads — and the phones send no schema at all. Everything the
// model should know about each field is already in the shared rules and JSON
// instruction, so descriptions here would only be desktop-only extra prompt.
const schema = z.object({
  title: z.string(),
  folders: z.array(z.object({ name: z.string(), isNew: z.boolean(), reason: z.string() })),
});

/**
 * Index the folder registry by trimmed, lowercased name. Models re-type folder
 * names rather than copying them, and "Acme Corp" vs "acme corp " is the model
 * being sloppy about spelling, not the user wanting a second folder. First
 * occurrence wins, so two folders sharing a name resolve to the older one.
 */
function indexByName(
  folders: readonly { id: string; name: string }[]
): Map<string, { id: string; name: string }> {
  const byName = new Map<string, { id: string; name: string }>();
  for (const folder of folders) {
    const key = folder.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, folder);
  }
  return byName;
}

/**
 * Turn the model's raw folder picks into the suggestions the UI can act on.
 *
 * Exported and pure because this is where the product's rules actually live:
 * the model is asked for the same constraints in the prompt, but a filing
 * suggestion that quietly creates three folders (or five) is worse than no
 * suggestion at all, so nothing here trusts the model to have complied.
 */
export function resolveFilingFolders(
  raw: readonly { name: string; isNew: boolean; reason: string }[],
  folders: readonly { id: string; name: string }[]
): FilingFolderSuggestion[] {
  const byName = indexByName(folders);
  const out: FilingFolderSuggestion[] = [];
  const seenIds = new Set<string>();
  let newTaken = false;

  for (const entry of raw) {
    // Cap at 3. The model returns best-first, so truncating the tail drops its
    // weakest picks; the UI has room for three chips.
    if (out.length >= 3) break;

    const name = entry.name?.trim() ?? "";
    // A blank name names no folder. Half-streamed and hallucinated rows both
    // land here, and there is nothing to file into either way.
    if (!name) continue;

    const reason = entry.reason?.trim() ?? "";
    const match = byName.get(name.toLowerCase());

    if (match) {
      // isNew is deliberately ignored when a real folder matches: the model
      // claiming "new" about a folder that already exists is a model error, not
      // the user asking for a duplicate. Filing into the existing one is always
      // what was meant.
      if (seenIds.has(match.id)) continue; // one entry per folder — repeats are noise
      seenIds.add(match.id);
      // The registry's spelling wins, so the chip reads exactly like the folder
      // the user already knows.
      out.push({ folderId: match.id, name: match.name, reason });
      continue;
    }

    // Unmatched → a folder that would have to be created. Only the FIRST one
    // survives: a new folder per meeting would explode the registry, and the
    // model orders best-first, so the first is the one worth offering. (This
    // also subsumes de-duping new suggestions by name — a second one is dropped
    // whether or not it repeats the first.)
    if (newTaken) continue;
    newTaken = true;
    out.push({ folderId: null, name, reason });
  }

  return out;
}

/** Which of the prompt's two languages the title and reasons are written in:
 *  the app's UI language, since both are shown in the library. */
export type FilingLanguage = keyof typeof FILING.languageInstruction;
export function filingLanguage(settings: Pick<Settings, "language">): FilingLanguage {
  return settings.language === "zh-TW" ? "zh-TW" : "en";
}

/**
 * The system prompt, identical on every platform: the rules, the output
 * language, then the JSON shape. Desktop ALSO uses schema/JSON mode, but sends
 * the shared JSON instruction rather than its own so the text the model reads
 * matches the phones' word for word. Nothing per-user rides along (no profile,
 * no meeting kind): the phones have neither, and one extra input is enough to
 * make the same recording come back with a different title.
 */
export function filingSystemPrompt(lang: FilingLanguage): string {
  return FILING.rules + FILING.languageInstruction[lang] + FILING.jsonInstruction;
}

/**
 * Cap the transcript at the shared budget, counted in Unicode code points (what
 * Swift's `count`-by-scalars and Kotlin's codePointCount agree on — UTF-16
 * length would cut CJK and emoji differently per platform). An over-long
 * transcript keeps its head and its tail, because a meeting is introduced at
 * the start and decided at the end; the middle is the cheapest part to lose.
 */
export function capFilingTranscript(transcript: string): string {
  const points = Array.from(transcript);
  const max = FILING.maxTranscriptCharacters;
  if (points.length <= max) return transcript;
  const head = Math.floor((max * FILING.headShareNumerator) / FILING.headShareDenominator);
  const tail = max - head;
  return points.slice(0, head).join("") + FILING.elisionMarker + points.slice(points.length - tail).join("");
}

/**
 * The user message, in the one order every platform sends: meeting context (if
 * any), the current title, the folder menu, then the transcript. Pure and
 * exported so the exact bytes are pinned by a test — this string is half of
 * what decides the title, and the phones assemble the same one.
 */
export function filingUserMessage(opts: {
  meetingContext?: string;
  currentTitle: string;
  /** Folder names as the model's menu of existing homes; trimmed, blanks dropped. */
  folderNames: readonly string[];
  /** The (already capped) transcript. */
  transcript: string;
}): string {
  const context = opts.meetingContext?.trim() ?? "";
  const names = opts.folderNames.map((n) => n.trim()).filter(Boolean);
  let msg = "";
  if (context) msg += `${FILING.meetingContextPrefix}${context}\n\n`;
  msg += `${FILING.currentTitlePrefix}${opts.currentTitle.trim() || FILING.untitled}\n\n`;
  msg +=
    names.length > 0
      ? `${FILING.foldersHeader}\n${names.map((n) => `- ${n}`).join("\n")}\n\n`
      : `${FILING.noFolders}\n\n`;
  return `${msg}${FILING.transcriptHeader}\n${opts.transcript}`;
}

/**
 * The Simplified-only characters every platform gates on — a fixed list in
 * shared/prompts/filing.json rather than a converter table, because iOS and
 * Android have no OpenCC and "which characters count as Simplified" has to be
 * the same answer on all three. Characters shared with everyday Traditional
 * (台, 里, 后…) are deliberately absent, so a Traditional title is never
 * mistaken for Simplified.
 */
const SIMPLIFIED_ONLY = new Set(Array.from(FILING.simplifiedOnlyChars));

/**
 * Decide whether the model's title is worth offering, applied the same way on
 * every platform. A rejected title is "" — the folder half of the answer still
 * stands, since a bad title says nothing about whether the folder pick is good.
 *
 *  - over the length cap: a paragraph is not a title, and truncating one would
 *    put words in the model's mouth;
 *  - Simplified Chinese the recording did not already contain: a Traditional
 *    user's library must not drift script because the model did. Judged per
 *    character against what the model was SHOWN (current title + transcript as
 *    sent), so a recording that is itself in Simplified can still be named in
 *    its own characters;
 *  - the current title back again: "keep it" is the model declining to rename,
 *    and offering a no-op rename would only be noise on the card.
 */
export function gateFilingTitle(
  raw: unknown,
  ctx: { currentTitle: string; transcript: string }
): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) return "";
  if (Array.from(title).length > FILING.maxTitleCharacters) return "";
  const known = new Set(Array.from(ctx.currentTitle + ctx.transcript));
  for (const ch of Array.from(title)) {
    if (SIMPLIFIED_ONLY.has(ch) && !known.has(ch)) return "";
  }
  if (title === ctx.currentTitle.trim()) return "";
  return title;
}

/**
 * Propose a better title and 2-3 filing folders for a finished recording.
 * Rides the user's cheap realtime lane (their own provider and key) for the
 * same reason meetingKind does — it is one short label off an
 * already-transcribed conversation, not an analysis. Everything the model reads
 * comes from shared/prompts/filing.json, so the phones ask the same question.
 *
 * Returns null when there is nothing to read, nothing worth offering, or the
 * pass fails; the caller keeps the recording's current title and leaves it
 * unfiled rather than guessing.
 */
export async function suggestFiling(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  meetingContext?: string;
  /** The personal folder registry, as the model's menu of existing homes. */
  folders: readonly { id: string; name: string }[];
  /** What the recording is called right now, so the model can decline to change it. */
  currentTitle: string;
}): Promise<FilingSuggestion | null> {
  const { settings, segments, names, meetingContext, folders, currentTitle } = opts;
  const full = transcriptWithTimestamps(segments, names);
  if (!full.trim()) return null;
  const transcript = capFilingTranscript(full);

  try {
    const { object, usage } = await streamObjectResilient({
      settings,
      workload: "realtime",
      schema,
      system: filingSystemPrompt(filingLanguage(settings)),
      prompt: filingUserMessage({
        meetingContext,
        currentTitle,
        folderNames: folders.map((f) => f.name),
        transcript,
      }),
      temperature: FILING.temperature,
    });
    void recordLlmUsage(settings, "realtime", "eval", usage);

    const title = gateFilingTitle(object.title, { currentTitle, transcript });
    const resolved = resolveFilingFolders(object.folders ?? [], folders);
    log.info("ai.filing: suggested", { title, folders: resolved.length });
    // Nothing survived either half → no suggestion at all, rather than an empty
    // shell the card would have to recognise as "nothing to show".
    if (!title && resolved.length === 0) return null;
    return { title, folders: resolved };
  } catch (e) {
    log.warn("ai.filing: failed", { error: String(e) });
    return null;
  }
}
