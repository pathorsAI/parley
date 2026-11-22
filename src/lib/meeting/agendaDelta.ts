// Which part of the live transcript the next agenda check should read.
//
// The in-meeting agenda check (checkTodos, every ~45 s while recording) used to
// resend the whole transcript each pass, so a meeting's cost grew with the
// square of its length (pathorsAI/parley-internal#100). The question it asks —
// "which still-open items are covered now?" — only needs what was said since
// the last pass that got an answer, plus a few lines before it so an item
// discussed across that boundary is not missed. This cursor remembers what a
// successful pass has already read. Everything here is pure; the caller owns
// the cursor and commits a plan only after the model answered.

import type { TodoItem, TranscriptSegment } from "../types";

/** Already-checked lines sent ahead of the new ones, as context only. */
export const AGENDA_OVERLAP_LINES = 4;
/** Most new transcript (rendered characters) one pass sends. After a long
 *  outage, or once the agenda gains an item, the backlog is trimmed to its
 *  most recent lines, so a failure can never rebuild the full-transcript
 *  request this cursor exists to avoid. */
export const AGENDA_MAX_NEW_CHARS = 12_000;

export interface AgendaCursor {
  /** The meeting this cursor belongs to (liveMeetingId); another id resets it. */
  meetingId: string | null;
  /** Lines a successful pass has read, keyed by id and text, so a final line
   *  the recognizer later rewrites counts as new again. */
  checked: Set<string>;
  /** The open items the last successful pass asked about (id and text). An
   *  open item outside this set — newly added, renamed, or unticked by the
   *  user — has never been checked against earlier speech. */
  askedItems: Set<string> | null;
}

export function createAgendaCursor(meetingId: string | null = null): AgendaCursor {
  return { meetingId, checked: new Set(), askedItems: null };
}

/** The cursor for `meetingId`: `cursor` itself when it already belongs to
 *  that meeting (a resume keeps its place), otherwise a fresh one. */
export function cursorForMeeting(cursor: AgendaCursor | null, meetingId: string | null): AgendaCursor {
  return cursor?.meetingId === meetingId ? cursor : createAgendaCursor(meetingId);
}

export interface AgendaCheckPlan {
  /** Up to AGENDA_OVERLAP_LINES lines just before `fresh`, already read. */
  context: TranscriptSegment[];
  /** The lines to check, oldest first, within AGENDA_MAX_NEW_CHARS. */
  fresh: TranscriptSegment[];
  /** Line keys the pass covers once it succeeds — `fresh` plus any backlog
   *  trimmed by the budget (re-sending those would only trim them again). */
  consumed: string[];
  /** The open items this pass asks about. */
  items: string[];
}

const lineKey = (s: TranscriptSegment) => `${s.id}\u0000${s.text.trim()}`;
const itemKey = (t: TodoItem) => `${t.id}\u0000${t.text}`;

/**
 * What the next check should send, or null when there is nothing to ask: no
 * open item, or no final speech since the last successful pass. `render` is
 * the line as the prompt writes it (its length is what the budget counts).
 *
 * The cursor is not touched; call {@link commitAgendaCheck} once the model
 * has answered, so a failed pass leaves its lines for the next one.
 */
export function planAgendaCheck(
  cursor: AgendaCursor,
  segments: readonly TranscriptSegment[],
  open: readonly TodoItem[],
  render: (s: TranscriptSegment) => string,
  maxChars: number = AGENDA_MAX_NEW_CHARS,
): AgendaCheckPlan | null {
  if (open.length === 0) return null;
  const items = open.map(itemKey);
  const spoken = segments
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);

  // An item never asked about needs the earlier speech too, not just the delta.
  const asked = cursor.askedItems;
  const agendaGrew = asked === null || items.some((k) => !asked.has(k));
  const pending = agendaGrew ? spoken : spoken.filter((s) => !cursor.checked.has(lineKey(s)));
  if (pending.length === 0) return null;

  // Keep the most recent lines that fit; always at least the newest one.
  let used = 0;
  let start = pending.length;
  while (start > 0) {
    const cost = render(pending[start - 1]).length + 1;
    if (start < pending.length && used + cost > maxChars) break;
    used += cost;
    start -= 1;
  }
  const fresh = pending.slice(start);

  const freshSet = new Set(fresh);
  const firstAt = spoken.indexOf(fresh[0]);
  const context = spoken
    .slice(0, firstAt)
    .filter((s) => !freshSet.has(s))
    .slice(-AGENDA_OVERLAP_LINES);

  return { context, fresh, consumed: pending.map(lineKey), items };
}

/** Record a pass the model answered: its lines are read, its items asked. */
export function commitAgendaCheck(cursor: AgendaCursor, plan: AgendaCheckPlan): void {
  for (const k of plan.consumed) cursor.checked.add(k);
  cursor.askedItems = new Set(plan.items);
}
