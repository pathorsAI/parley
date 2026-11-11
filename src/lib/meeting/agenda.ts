// The meeting's agenda (a draft's `todos`) as the meeting tracks it: who ticked
// what and where in the recording, the progress the floating window's agenda
// bar shows, the one end-of-meeting reminder, and what is left for the report.
// Everything here is pure; the store, the bar and the report call into it.

import type { TodoItem } from "../types";
import type { NewDraftFields } from "../store/prep";

/** One item the AI heard covered, and where (ms on the transcript's clock;
 *  undefined when the model named no usable line). */
export interface AgendaCheck {
  id: string;
  atMs?: number;
}

/**
 * A model-written `m:ss`, `mm:ss` or `h:mm:ss` (the transcript's `[m:ss]`
 * stamps, see transcriptWithTimestamps) as milliseconds. Anything else — an
 * empty string, words, seconds past 59 — is undefined: a wrong jump target is
 * worse than none.
 */
export function parseClock(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  const m = /^\[?\s*(?:(\d+):)?(\d{1,3}):(\d{2})\s*\]?$/.exec(raw.trim());
  if (!m) return undefined;
  const [, h, mm, ss] = m;
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (seconds > 59 || (h != null && minutes > 59)) return undefined;
  return ((Number(h ?? 0) * 60 + minutes) * 60 + seconds) * 1000;
}

/** The AI's ticks applied to the agenda: each named item done, by the AI, at
 *  the line it named. An item the user took over (aiDismissed) or already
 *  ticked stays as it is. */
export function applyAiChecks(todos: readonly TodoItem[], checks: readonly AgendaCheck[]): TodoItem[] {
  const at = new Map(checks.map((c) => [c.id, c.atMs]));
  return todos.map((t) => {
    if (!at.has(t.id) || t.done || t.aiDismissed) return t;
    const atMs = at.get(t.id);
    return { ...t, done: true, doneBy: "ai" as const, ...(atMs == null ? {} : { doneAtMs: atMs }) };
  });
}

/** The user's click on one item. Ticking is the user's (no time point);
 *  unticking one the AI ticked marks it dismissed, so the next AI pass leaves
 *  it alone. */
export function toggleAgendaItem(t: TodoItem): TodoItem {
  const rest: TodoItem = { ...t };
  delete rest.doneBy;
  delete rest.doneAtMs;
  if (!t.done) return { ...rest, done: true, doneBy: "user" };
  return t.doneBy === "ai" ? { ...rest, done: false, aiDismissed: true } : { ...rest, done: false };
}

/** What the agenda bar shows: how many are done, the bar's fill (0–1), and
 *  the first item still open — the "next" one — or null when all are done. */
export interface AgendaProgress {
  done: number;
  total: number;
  fraction: number;
  next: TodoItem | null;
}

export function agendaProgress(todos: readonly TodoItem[]): AgendaProgress {
  const total = todos.length;
  const done = todos.filter((t) => t.done).length;
  return {
    done,
    total,
    fraction: total ? done / total : 0,
    next: todos.find((t) => !t.done) ?? null,
  };
}

/** `2/3` — the count the bar and the mini window show. */
export function agendaCount(p: Pick<AgendaProgress, "done" | "total">): string {
  return `${p.done}/${p.total}`;
}

/** How long before the drafted end the reminder fires. */
export const AGENDA_REMINDER_LEAD_MS = 5 * 60_000;

/**
 * Is the end-of-meeting reminder due? Only for a meeting with an end time,
 * from five minutes before it, while something is still open — and once per
 * meeting (`alreadyShown`).
 */
export function agendaReminderDue(p: {
  now: number;
  meetingEndAt: number | null;
  todos: readonly TodoItem[];
  alreadyShown: boolean;
}): boolean {
  if (p.alreadyShown || p.meetingEndAt == null) return false;
  if (p.now < p.meetingEndAt - AGENDA_REMINDER_LEAD_MS) return false;
  return p.todos.some((t) => !t.done);
}

/** The agenda items a meeting never got to — the report's 沒談到的議程. */
export function uncoveredAgenda(agenda: readonly TodoItem[] | null | undefined): TodoItem[] {
  return (agenda ?? []).filter((t) => !t.done && t.text.trim());
}

/** The new draft 帶到新的會議草稿 files: the uncovered items as a fresh,
 *  unticked agenda under `title`, everything else empty — the next meeting is
 *  set up from there in the draft sheet. */
export function carryOverDraft(title: string, uncovered: readonly TodoItem[]): NewDraftFields {
  return {
    title,
    meetingAt: null,
    meetingEndAt: null,
    reminderLeadMin: null,
    meetingContext: "",
    meetingFolderId: null,
    agenda: uncovered.map((t) => t.text.trim()).filter(Boolean),
  };
}
