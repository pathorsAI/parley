import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { log } from "../log";
import type {
  FilingFolderSuggestion,
  FilingSuggestion,
  MeetingKind,
  Settings,
  TranscriptSegment,
} from "../types";

// No .min()/.max() on the array: the JSON-mode providers we wire (Groq and the
// other openai-compatible ones) choke on count constraints, and a rejected
// schema costs us the whole pass. The 1-3 count is asked for in the prompt and
// ENFORCED in resolveFilingFolders, which has to survive a disobedient model
// anyway (cf. timeline.ts / actionItems.ts, which take the same line).
const schema = z.object({
  title: z
    .string()
    .describe(
      "The proposed display title for this recording — what it was about and, where clear, with whom. " +
        "Return the current title unchanged if it is already good."
    ),
  folders: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "The folder name. Copy an existing folder's name EXACTLY when you mean that folder."
          ),
        isNew: z
          .boolean()
          .describe("true only when this folder does not exist yet and must be created."),
        reason: z.string().describe("One short clause saying why this folder fits."),
      })
    )
    .describe("2-3 candidate folders for this recording, best first."),
});

const SYSTEM = `Given a finished meeting transcript, decide what the recording should be CALLED and where it should be FILED. Both doors into a recording name it badly — a live meeting arrives as "即時會議 · <date>" and an upload arrives as its file name — so this is usually the first honest title the recording gets.

TITLE
- Say what the meeting was ABOUT and, where it is clear, WITH WHOM: a company or a person plus the topic or the decision reached.
- No date and no time. The library card already shows those, so spending the title on them wastes the only line the user reads.
- No filler as the subject: "meeting", "recording", "call", "討論" and the like describe every recording in the library and therefore identify none of them. A title that would fit any meeting is a failed title.
- Keep it short — roughly 10-24 characters of CJK, or about 4-8 English words.
- If the current title is already specific and accurate, return it UNCHANGED. Churn for its own sake makes the library harder to trust, not easier.

FOLDERS
- The user's existing folders are listed below. Strongly prefer them. One folder is typically one customer/company or one ongoing workstream, so ask which of those this conversation belongs to.
- Return 2-3 candidates ordered best-first. If only one is genuinely defensible, return one — a padded list is worse than a short one.
- Copy an existing folder's name EXACTLY (character for character) when you mean that folder, and set isNew to false.
- AT MOST ONE candidate may be a folder that does not exist yet (isNew: true), and only when no existing folder honestly fits. A new folder per meeting would grow the registry faster than the user can prune it.
- reason is ONE short clause saying why the folder fits — it is shown as a tooltip, not read as prose.`;

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
  // Match on the trimmed, lowercased name: models re-type folder names rather
  // than copying them, and "Acme Corp" vs "acme corp " is the model being
  // sloppy about spelling, not the user wanting a second folder.
  const byName = new Map<string, { id: string; name: string }>();
  for (const folder of folders) {
    const key = folder.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, folder);
  }

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

/** Render the folder registry as the model's menu of existing homes. */
function folderMenu(folders: readonly { id: string; name: string }[]): string {
  const names = folders.map((f) => f.name.trim()).filter(Boolean);
  if (names.length === 0) {
    return (
      "The user has NO folders yet, so every suggestion would have to be created — " +
      "return exactly ONE folder, with isNew: true.\n\n"
    );
  }
  return `The user's existing folders:\n${names.map((n) => `- ${n}`).join("\n")}\n\n`;
}

/**
 * Propose a better title and 2-3 filing folders for a finished recording.
 * Rides the cheap realtime lane for the same reason meetingKind does — it is
 * one short label off an already-transcribed conversation, not an analysis.
 *
 * Returns null when there is nothing to read or the pass fails; the caller keeps
 * the recording's current title and leaves it unfiled rather than guessing.
 */
export async function suggestFiling(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  meetingContext?: string;
  meetingKind?: MeetingKind | null;
  /** The personal folder registry, as the model's menu of existing homes. */
  folders: readonly { id: string; name: string }[];
  /** What the recording is called right now, so the model can decline to change it. */
  currentTitle: string;
}): Promise<FilingSuggestion | null> {
  const { settings, segments, names, meetingContext, meetingKind, folders, currentTitle } = opts;
  const transcript = transcriptWithTimestamps(segments, names);
  if (!transcript.trim()) return null;

  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "") +
    (meetingKind ? `Meeting kind: ${meetingKind}\n\n` : "") +
    `The recording is currently called: ${currentTitle.trim() || "(untitled)"}\n\n` +
    folderMenu(folders);

  try {
    const { object, usage } = await streamObjectResilient({
      settings,
      workload: "realtime",
      schema,
      // The title and each reason are shown in the library, so they follow the
      // UI language rather than the transcript's.
      system: SYSTEM + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
      prompt: `${ctx}Transcript:\n${transcript}`,
    });
    void recordLlmUsage(settings, "realtime", "eval", usage);

    const title = typeof object.title === "string" ? object.title.trim() : "";
    const resolved = resolveFilingFolders(object.folders ?? [], folders);
    log.info("ai.filing: suggested", { title, folders: resolved.length });
    return { title, folders: resolved };
  } catch (e) {
    log.warn("ai.filing: failed", { error: String(e) });
    return null;
  }
}
