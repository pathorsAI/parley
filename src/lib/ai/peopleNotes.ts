import { z } from "zod";
import { generateObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { parseClock } from "../meeting/agenda";
import { containment } from "../meeting/suggestMatch";
import { log } from "../log";
import type { Settings, TranscriptSegment } from "../types";

/** Transcript characters sent: the head and the tail, where people chat. */
const MAX_TRANSCRIPT_CHARS = 24_000;
/** Candidates kept from one recording. */
export const MAX_CANDIDATES = 8;
/** A candidate's quote must share this much of its wording with the
 *  transcript, or the model made it up. */
const QUOTE_FOUND_THRESHOLD = 0.6;

// No .min()/.max() and no .describe(): the JSON-mode providers choke on count
// constraints (see ai/filing.ts); the limits are asked for in the prompt and
// enforced in checkedCandidates.
const schema = z.object({
  notes: z.array(
    z.object({ name: z.string(), org: z.string(), text: z.string(), quote: z.string(), at: z.string() }),
  ),
});

export const PEOPLE_NOTES_SYSTEM = `You read a meeting transcript and pick out what the user could bring up as small talk with each OTHER person the next time they meet, or should remember about them.

Return JSON: { "notes": [ { "name", "org", "text", "quote", "at" } ] }.
- name: the person the note is about, as they are named in the transcript or the meeting background. Never the user. Skip anyone you cannot name: a label like "Speaker 2" or "Remote 1" is not a name.
- org: their company or team if it is stated, else "".
- text: ONE short sentence, in the language the meeting was held in, stating the fact (e.g. "十二月要去北海道滑雪", "Moving the team to a new office in March"). Not advice, not a question.
- quote: the words from the transcript it is based on, copied exactly.
- at: the [m:ss] stamp of that line.

Worth a note: a trip, a move, a new job or role, a busy season, a launch, a hobby, how they like to be contacted, something they said they are looking forward to or tired of — things a person says about themselves in passing.

Never write a note about: health or medical matters, family conflict, relationships, money trouble, politics, religion, or one person's opinion of another person. Never write a note from the deal itself (prices, objections, requirements, next steps): that is what the meeting report is for. Never infer: every note must rest on a line that is in the transcript.

At most ${MAX_CANDIDATES} notes, the most specific first. Most meetings have none or one or two: return { "notes": [] } when nothing qualifies.`;

/** One candidate as the model returned it, checked. */
export interface ExtractedNote {
  name: string;
  org: string;
  text: string;
  quote: string;
  atMs?: number;
}

/** The transcript as sent: all of it when short, else its head and tail. */
export function capPeopleTranscript(transcript: string): string {
  const points = Array.from(transcript);
  if (points.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  return `${points.slice(0, half).join("")}\n[…]\n${points.slice(-half).join("")}`;
}

/** A speaker label the app made up, not a person's name. */
const PLACEHOLDER_NAME = /^(me|我|speaker|remote|講者|對方|說話者)\s*\d*$/i;

/**
 * The model's notes, trusted as little as possible: blank fields, placeholder
 * names, anything about the user, a quote that is not in the transcript and
 * repeats are dropped; the rest is cut to MAX_CANDIDATES. Pure.
 */
export function checkedCandidates(
  raw: readonly { name?: unknown; org?: unknown; text?: unknown; quote?: unknown; at?: unknown }[],
  ctx: { transcript: string; selfNames: readonly string[] },
): ExtractedNote[] {
  const self = new Set(ctx.selfNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: ExtractedNote[] = [];
  for (const r of raw) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    if (!name || !text || !quote) continue;
    if (PLACEHOLDER_NAME.test(name) || self.has(name.toLowerCase())) continue;
    if (containment(quote, ctx.transcript) < QUOTE_FOUND_THRESHOLD) continue;
    const key = `${name.toLowerCase()}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const note: ExtractedNote = { name, org: typeof r.org === "string" ? r.org.trim() : "", text, quote };
    const atMs = parseClock(typeof r.at === "string" ? r.at : null);
    if (atMs !== undefined) note.atMs = atMs;
    out.push(note);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Read a finished recording for small-talk candidates. Rides the cheap
 * realtime lane, like the filing pass. Returns null when the pass fails (so
 * the caller can try again another time) and [] when there is nothing.
 */
export async function extractPeopleNotes(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  meetingContext?: string;
  /** What the user is called, so nothing is written about them. */
  selfNames: readonly string[];
  signal?: AbortSignal;
}): Promise<ExtractedNote[] | null> {
  const { settings, segments, names, meetingContext, selfNames, signal } = opts;
  const full = transcriptWithTimestamps(segments, names);
  if (!full.trim()) return [];
  const transcript = capPeopleTranscript(full);
  const context = meetingContext?.trim();
  const user = selfNames.filter(Boolean).join(", ");
  const prompt =
    (user ? `The user is: ${user}\n\n` : "") +
    (context ? `Meeting background:\n${context}\n\n` : "") +
    `Transcript:\n${transcript}`;
  try {
    const { object, usage } = await generateObjectResilient({
      settings,
      workload: "realtime",
      feature: "meeting",
      schema,
      system: PEOPLE_NOTES_SYSTEM,
      prompt,
      temperature: 0,
      signal,
    });
    void recordLlmUsage(settings, "realtime", "eval", usage);
    const notes = checkedCandidates(object.notes ?? [], { transcript, selfNames });
    log.info("ai.peopleNotes: read", { returned: object.notes?.length ?? 0, kept: notes.length });
    return notes;
  } catch (e) {
    log.warn("ai.peopleNotes: failed", { error: String(e) });
    return null;
  }
}
