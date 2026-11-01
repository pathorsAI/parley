// The notes typed in the floating meeting window, as they ride along in a saved
// recording's meeting context. Pure — no store, no IPC.

import { DICTS, translate } from "../../i18n/messages";
import type { AppLanguage } from "../types";

/**
 * The meeting's context as saved: the prepared context, then the notes typed
 * during the meeting under a heading — so the report and every later analysis
 * read them along with the context. Pure; exported for testing.
 */
export function contextWithNotes(context: string, notes: string, heading: string): string {
  const n = notes.trim();
  if (!n) return context;
  const c = context.trim();
  return c ? `${c}\n\n${heading}\n${n}` : `${heading}\n${n}`;
}

/**
 * The in-meeting notes back out of a saved context — the inverse of
 * {@link contextWithNotes}. `headings` are the notes headings to look for (the
 * heading is written in the app language of the day the meeting was saved, so
 * callers pass every language's). The LAST heading wins: anything after it is
 * the notes. "" when the context carries no notes.
 */
export function notesFromContext(context: string, headings: readonly string[]): string {
  let start = -1;
  for (const heading of headings) {
    if (!heading) continue;
    const atStart = context.startsWith(`${heading}\n`) ? heading.length + 1 : -1;
    const marker = `\n\n${heading}\n`;
    const mid = context.lastIndexOf(marker);
    const at = mid >= 0 ? mid + marker.length : atStart;
    if (at > start) start = at;
  }
  return start < 0 ? "" : context.slice(start).trim();
}

/** The notes heading in every app language, whichever one wrote the entry. */
const NOTES_HEADINGS = (Object.keys(DICTS) as AppLanguage[]).map((lang) =>
  translate(lang, "floating.notesHeading"),
);

/** The in-meeting notes of a saved meeting context ("" when none were taken). */
export function meetingNotesOf(context: string | null | undefined): string {
  return context ? notesFromContext(context, NOTES_HEADINGS) : "";
}
