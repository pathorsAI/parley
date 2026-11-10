// Who an action item belongs to, kept in step with the speaker names.
//
// The model names an owner by the label the transcript showed it ("Speaker 2",
// or a name the user had already typed). Renaming that speaker afterwards must
// rename the owner too, so an owner that is a speaker is tied to the speaker's
// key, and shown by the speaker's current name.

import type { ActionItem, TranscriptSegment } from "../types";
import { defaultSpeakerLabel, speakerKey, speakerLabel } from "./labels";

type Line = Pick<TranscriptSegment, "source" | "speaker">;

/** One line per distinct speaker. */
function speakersOf(segments: readonly Line[]): Map<string, Line> {
  const out = new Map<string, Line>();
  for (const s of segments) {
    const key = speakerKey(s);
    if (!out.has(key)) out.set(key, s);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The speaker an owner name points at: the one whose current name or default
 * label ("Speaker 2") it is. Undefined when it names no speaker (someone only
 * mentioned) or more than one could be meant. Pure.
 */
export function ownerSpeakerKey(
  owner: string | undefined,
  segments: readonly Line[],
  names: Record<string, string>,
): string | undefined {
  const want = owner ? norm(owner) : "";
  if (!want) return undefined;
  const hits: string[] = [];
  for (const [key, line] of speakersOf(segments)) {
    const custom = names[key];
    if ((custom && norm(custom) === want) || norm(defaultSpeakerLabel(line)) === want) hits.push(key);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** Tie each speaker-owner to its speaker's key (for items fresh from the
 *  model, before the user renames anyone). Pure. */
export function withOwnerKeys(
  items: ActionItem[],
  segments: readonly Line[],
  names: Record<string, string>,
): ActionItem[] {
  return items.map((a) => {
    if (a.ownerKey || !a.owner) return a;
    const key = ownerSpeakerKey(a.owner, segments, names);
    return key ? { ...a, ownerKey: key } : a;
  });
}

/**
 * The owner as it reads now: the speaker's current name when the owner is a
 * speaker, else the name as written. Items saved before owners had keys are
 * matched by name, so a "Speaker 2" owner follows a rename of Speaker 2.
 * `label` renders the speaker (the screen passes the localized
 * displaySpeakerLabel); matching always reads the English defaults the model
 * was given. Pure.
 */
export function ownerDisplayName(
  item: Pick<ActionItem, "owner" | "ownerKey">,
  segments: readonly Line[],
  names: Record<string, string>,
  label: (line: Line) => string = (line) => speakerLabel(line, names),
): string | undefined {
  const speakers = speakersOf(segments);
  const key = item.ownerKey && speakers.has(item.ownerKey) ? item.ownerKey : ownerSpeakerKey(item.owner, segments, names);
  const line = key ? speakers.get(key) : undefined;
  return line ? label(line) : item.owner;
}
