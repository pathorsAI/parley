// A meeting draft's opening: what the user says in the first minute. Small
// talk first (a few lines to pick from), then the standard opening — thanks,
// how long, what will be covered, a check that this works for the other side.
// Unlike the playbook, which live suggestions pick from now and then, the
// opening is on screen from the first second of the meeting and stays until it
// has been said or put away. Everything here is pure.

import { containment, SAID_IT_THRESHOLD } from "./suggestMatch";

export interface MeetingOpening {
  /** The standard opening, written to be read aloud as is. */
  script: string;
  /** Small-talk lines, each a complete sentence. */
  smallTalk: string[];
}

/** Characters in the standard opening. */
export const MAX_OPENING_SCRIPT = 600;
/** Small-talk lines per draft. */
export const MAX_SMALL_TALK_ITEMS = 8;
/** Characters per small-talk line. */
export const MAX_SMALL_TALK_TEXT = 300;

/** The opening leaves by itself this long into the meeting, said or not: past
 *  that point it is only in the way of the suggestions it holds back. */
export const OPENING_MAX_MS = 5 * 60_000;

/** The share of the standard opening's wording the user's own lines must
 *  carry before it counts as said. Higher than one suggestion's threshold:
 *  it is matched against everything said so far, not one line. */
export const OPENING_SAID_THRESHOLD = 0.5;

const EMPTY: MeetingOpening = Object.freeze({ script: "", smallTalk: Object.freeze([]) as unknown as string[] });

/** The opening of a draft that has none. One shared frozen value. */
export function emptyOpening(): MeetingOpening {
  return EMPTY;
}

export function isOpeningEmpty(o: MeetingOpening | null | undefined): boolean {
  return !o || (!o.script.trim() && o.smallTalk.length === 0);
}

/**
 * Whatever came off disk, the cloud or an MCP client, as a well-formed
 * opening: texts trimmed and capped, blank and repeated small-talk lines
 * dropped. A draft saved before openings existed reads as the empty one.
 */
export function normalizeOpening(raw: unknown): MeetingOpening {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const script = typeof r.script === "string" ? r.script.trim().slice(0, MAX_OPENING_SCRIPT) : "";
  const smallTalk: string[] = [];
  for (const item of Array.isArray(r.smallTalk) ? r.smallTalk : []) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_SMALL_TALK_TEXT);
    if (text && !smallTalk.includes(text)) smallTalk.push(text);
    if (smallTalk.length >= MAX_SMALL_TALK_ITEMS) break;
  }
  if (!script && smallTalk.length === 0) return EMPTY;
  return { script, smallTalk };
}

/** `o` with one more small-talk line; unchanged when it is blank, already
 *  there, or the list is full. */
export function openingWithSmallTalk(o: MeetingOpening, text: string): MeetingOpening {
  const next = normalizeOpening({ script: o.script, smallTalk: [...o.smallTalk, text] });
  return next.smallTalk.length === o.smallTalk.length ? o : next;
}

/** `o` without its small-talk line at `index`. */
export function openingWithoutSmallTalk(o: MeetingOpening, index: number): MeetingOpening {
  return { script: o.script, smallTalk: o.smallTalk.filter((_, i) => i !== index) };
}

/** One finished transcript line, as far as the opening cares. */
export interface SpokenLine {
  who: "me" | "them";
  text: string;
}

/**
 * Has the user said the opening? With a standard opening: once the user's own
 * lines, taken together, carry enough of its wording (people paraphrase and
 * split it over several sentences). With small talk only: once one of its
 * lines has been said. When no line is marked as the user's — one microphone
 * in a room, where the transcript cannot tell — every line counts.
 */
export function openingSaid(o: MeetingOpening, lines: readonly SpokenLine[]): boolean {
  if (isOpeningEmpty(o)) return false;
  const mine = lines.some((l) => l.who === "me") ? lines.filter((l) => l.who === "me") : lines;
  const spoken = mine.map((l) => l.text).join(" ");
  if (!spoken.trim()) return false;
  if (o.script.trim()) return containment(o.script, spoken) >= OPENING_SAID_THRESHOLD;
  return o.smallTalk.some((line) => containment(line, spoken) >= SAID_IT_THRESHOLD);
}

/** Is the opening card up? It needs something to show, a meeting that is
 *  running, and not to have been said or put away. */
export function openingShowing(s: {
  meetingOpening: MeetingOpening;
  openingDismissed: boolean;
  meetingStatus: string;
}): boolean {
  if (s.openingDismissed || isOpeningEmpty(s.meetingOpening)) return false;
  return s.meetingStatus === "recording" || s.meetingStatus === "paused";
}
