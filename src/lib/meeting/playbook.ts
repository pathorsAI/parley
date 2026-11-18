// A meeting draft's playbook: what to ask, how to steer when the other side
// says something specific, and where the conversation can go next. The live
// suggestions (meeting/liveSuggest.ts) pick from it; Parley Cloud stores it with
// the draft. Everything here is pure.

/** A question worth asking, written the way it would be said. */
export interface PlaybookQuestion {
  id: string;
  text: string;
}

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
  questions: PlaybookQuestion[];
  branches: PlaybookBranch[];
  topics: PlaybookTopic[];
}

/** Items per list. Matches the cloud's validation (parley-internal drafts.ts). */
export const MAX_PLAYBOOK_ITEMS = 30;
/** Characters per text field. */
export const MAX_PLAYBOOK_TEXT = 300;
const MAX_ID = 128;

export function emptyPlaybook(): MeetingPlaybook {
  return { questions: [], branches: [], topics: [] };
}

export function isPlaybookEmpty(p: MeetingPlaybook | null | undefined): boolean {
  return !p || (p.questions.length === 0 && p.branches.length === 0 && p.topics.length === 0);
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
 * existed reads as the empty one.
 */
export function normalizePlaybook(raw: unknown): MeetingPlaybook {
  if (!raw || typeof raw !== "object") return emptyPlaybook();
  const r = raw as Record<string, unknown>;
  return {
    questions: list(r.questions)
      .map((q) => ({ id: id(q.id), text: text(q.text) }))
      .filter((q) => q.text)
      .slice(0, MAX_PLAYBOOK_ITEMS),
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

/** A playbook from plain MCP arguments: question and topic strings, and
 *  `{ when, then }` branches. Ids are minted. */
export function playbookFromLists(lists: {
  questions?: readonly string[] | null;
  branches?: readonly { when: string; then: string }[] | null;
  topics?: readonly string[] | null;
}): MeetingPlaybook {
  return normalizePlaybook({
    questions: (lists.questions ?? []).map((t) => ({ text: t })),
    branches: lists.branches ?? [],
    topics: (lists.topics ?? []).map((t) => ({ text: t })),
  });
}
