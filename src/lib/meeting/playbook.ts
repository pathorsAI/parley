// A meeting draft's playbook: how to steer when the other side says something
// specific, and where the conversation can go next. What to ask or cover is the
// draft's agenda (its todos), not part of the playbook. The live suggestions
// (meeting/liveSuggest.ts) pick from both; Parley Cloud stores the playbook with
// the draft. Everything here is pure, apart from minting ids.

import type { TodoItem } from "../types";

/** A branch: when the other side says `when`, steer with `then`. */
export interface PlaybookBranch {
  id: string;
  when: string;
  then: string;
}

/** A direction the conversation can take when it runs dry. */
export interface PlaybookTopic {
  id: string;
  text: string;
}

export interface MeetingPlaybook {
  branches: PlaybookBranch[];
  topics: PlaybookTopic[];
}

/** Items per list. Matches the cloud's validation (parley-internal drafts.ts). */
export const MAX_PLAYBOOK_ITEMS = 30;
/** Characters per text field. */
export const MAX_PLAYBOOK_TEXT = 300;
const MAX_ID = 128;

export function emptyPlaybook(): MeetingPlaybook {
  return { branches: [], topics: [] };
}

export function isPlaybookEmpty(p: MeetingPlaybook | null | undefined): boolean {
  return !p || (p.branches.length === 0 && p.topics.length === 0);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_PLAYBOOK_TEXT) : "";
}

function id(v: unknown): string {
  return typeof v === "string" && v && v.length <= MAX_ID ? v : crypto.randomUUID();
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

/**
 * Whatever came off disk, the cloud or an MCP client, as a well-formed
 * playbook: missing lists are empty, blank items dropped, texts trimmed and
 * capped, ids kept (or minted when absent). A draft saved before playbooks
 * existed reads as the empty one. A `questions` list (playbooks briefly had
 * one) is dropped here; {@link legacyQuestions} reads it for the agenda.
 */
export function normalizePlaybook(raw: unknown): MeetingPlaybook {
  if (!raw || typeof raw !== "object") return emptyPlaybook();
  const r = raw as Record<string, unknown>;
  return {
    branches: list(r.branches)
      .map((b) => ({ id: id(b.id), when: text(b.when), then: text(b.then) }))
      .filter((b) => b.when && b.then)
      .slice(0, MAX_PLAYBOOK_ITEMS),
    topics: list(r.topics)
      .map((t) => ({ id: id(t.id), text: text(t.text) }))
      .filter((t) => t.text)
      .slice(0, MAX_PLAYBOOK_ITEMS),
  };
}

/** The questions of a playbook saved while playbooks still had a `questions`
 *  list, with ids that are stable across reads: the question's own, or one
 *  derived from its position. */
function legacyQuestionItems(rawPlaybook: unknown): { id: string; text: string }[] {
  if (!rawPlaybook || typeof rawPlaybook !== "object") return [];
  return list((rawPlaybook as Record<string, unknown>).questions)
    .map((q, i) => ({
      id: typeof q.id === "string" && q.id && q.id.length <= MAX_ID ? q.id : `legacy-question-${i}`,
      text: text(q.text),
    }))
    .filter((q) => q.text);
}

/**
 * The question texts of a playbook saved while playbooks still had a
 * `questions` list (trimmed, blanks dropped). Those questions now belong in the
 * agenda; whoever reads such a draft from outside folds them in with
 * {@link withLegacyQuestions}. Pure.
 */
export function legacyQuestions(rawPlaybook: unknown): string[] {
  return legacyQuestionItems(rawPlaybook).map((q) => q.text);
}

/**
 * `todos` with the legacy playbook questions of `rawPlaybook` folded in as
 * unticked items (see {@link legacyQuestions}), skipping any whose trimmed
 * text is already on the agenda. The new items' ids come from the questions,
 * so reading the same draft twice gives the same agenda (the cloud sync's
 * fingerprints rely on it). `todos` itself when there is nothing to add.
 */
export function withLegacyQuestions(todos: TodoItem[], rawPlaybook: unknown): TodoItem[] {
  const texts = new Set(todos.map((t) => t.text.trim()));
  const ids = new Set(todos.map((t) => t.id));
  const added: TodoItem[] = [];
  for (const q of legacyQuestionItems(rawPlaybook)) {
    if (texts.has(q.text) || ids.has(q.id)) continue;
    texts.add(q.text);
    ids.add(q.id);
    added.push({ id: q.id, text: q.text, done: false });
  }
  return added.length ? [...todos, ...added] : todos;
}

/** A playbook from plain MCP arguments: topic strings and `{ when, then }`
 *  branches. Ids are minted. */
export function playbookFromLists(lists: {
  branches?: readonly { when: string; then: string }[] | null;
  topics?: readonly string[] | null;
}): MeetingPlaybook {
  return normalizePlaybook({
    branches: lists.branches ?? [],
    topics: (lists.topics ?? []).map((t) => ({ text: t })),
  });
}

// ── Editing (the draft sheet) ──────────────────────────────────────────────────

/** The two playbook lists, by name. */
export type PlaybookList = keyof MeetingPlaybook;

/** The editable fields of a playbook item: `text` for a topic,
 *  `when` / `then` for a branch. */
export type PlaybookItemFields = { text?: string; when?: string; then?: string };

/** A playbook item's field, trimmed and capped. */
function itemText(v: string | undefined): string {
  return (v ?? "").trim().slice(0, MAX_PLAYBOOK_TEXT);
}

/** `p` with a new item (a fresh id) at the end of `list`; unchanged when the
 *  item is blank (a branch needs both sides) or the list is full. */
export function playbookWithItem(p: MeetingPlaybook, list: PlaybookList, f: PlaybookItemFields): MeetingPlaybook {
  if (p[list].length >= MAX_PLAYBOOK_ITEMS) return p;
  const id = crypto.randomUUID();
  if (list === "branches") {
    const when = itemText(f.when);
    const then = itemText(f.then);
    if (!when || !then) return p;
    return { ...p, branches: [...p.branches, { id, when, then }] };
  }
  const text = itemText(f.text);
  if (!text) return p;
  return { ...p, topics: [...p.topics, { id, text }] };
}

/** `p` without item `id` of `list`. Pure. */
export function playbookWithoutItem(p: MeetingPlaybook, list: PlaybookList, id: string): MeetingPlaybook {
  return { ...p, [list]: (p[list] as { id: string }[]).filter((x) => x.id !== id) };
}
