// Per-person notes for small talk: who someone is, and a few short things
// worth remembering about them, each dated and traceable to the recording it
// came from. Deliberately not a CRM — no companies, deals, stances or
// pipeline (that was built and removed, see docs/design/mini-crm.md). Two
// kinds of thing only: a person, and the notes under them.
//
// A note extracted after a meeting starts as a CANDIDATE: nothing reads it
// (the MCP tools included) until the user keeps it on that recording's report.
// A note added by hand or over MCP is kept from the start.
//
// People are matched by name (or alias), case-insensitively, and by
// organisation when both sides give one. Everything here is pure, apart from
// minting ids.

export type NoteStatus = "candidate" | "kept";

export interface PersonNote {
  id: string;
  /** One sentence: something to pick up on next time, or to remember. */
  text: string;
  /** When it was said (epoch ms): the meeting's date. */
  saidAt: number;
  /** Where it came from; absent for a note added by hand. */
  recordingId?: string;
  /** Position in that recording (ms). */
  atMs?: number;
  /** The words it was drawn from. */
  quote?: string;
  status: NoteStatus;
  createdAt: number;
}

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  /** Company or team; "" when unknown. */
  org: string;
  notes: PersonNote[];
  updatedAt: number;
}

export interface PeopleDoc {
  people: Person[];
  /** Recordings already read for candidates, newest last. */
  extracted: string[];
}

/** Kept notes per person; the oldest go first. */
export const MAX_NOTES_PER_PERSON = 20;
export const MAX_NOTE_TEXT = 200;
export const MAX_QUOTE_TEXT = 300;
export const MAX_NAME_TEXT = 80;
/** How many extracted recording ids are remembered. */
export const MAX_EXTRACTED = 500;

export function emptyPeople(): PeopleDoc {
  return { people: [], extracted: [] };
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function normalizeNote(raw: unknown): PersonNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = str(r.text, MAX_NOTE_TEXT);
  if (!text || typeof r.id !== "string" || !r.id) return null;
  const note: PersonNote = {
    id: r.id,
    text,
    saidAt: num(r.saidAt) ?? 0,
    status: r.status === "candidate" ? "candidate" : "kept",
    createdAt: num(r.createdAt) ?? 0,
  };
  const recordingId = str(r.recordingId, 128);
  if (recordingId) note.recordingId = recordingId;
  const atMs = num(r.atMs);
  if (atMs !== undefined) note.atMs = atMs;
  const quote = str(r.quote, MAX_QUOTE_TEXT);
  if (quote) note.quote = quote;
  return note;
}

/** Whatever came off disk as a well-formed document; malformed people and
 *  notes are dropped, and a person left with no notes goes too. */
export function normalizePeople(raw: unknown): PeopleDoc {
  if (!raw || typeof raw !== "object") return emptyPeople();
  const r = raw as Record<string, unknown>;
  const people: Person[] = [];
  for (const p of Array.isArray(r.people) ? r.people : []) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    const name = str(q.name, MAX_NAME_TEXT);
    if (!name || typeof q.id !== "string" || !q.id) continue;
    const notes = (Array.isArray(q.notes) ? q.notes : []).map(normalizeNote).filter((n): n is PersonNote => !!n);
    if (notes.length === 0) continue;
    people.push({
      id: q.id,
      name,
      aliases: (Array.isArray(q.aliases) ? q.aliases : []).map((a) => str(a, MAX_NAME_TEXT)).filter(Boolean),
      org: str(q.org, MAX_NAME_TEXT),
      notes,
      updatedAt: num(q.updatedAt) ?? 0,
    });
  }
  const extracted = (Array.isArray(r.extracted) ? r.extracted : []).filter((x): x is string => typeof x === "string");
  return { people, extracted: extracted.slice(-MAX_EXTRACTED) };
}

const key = (s: string) => s.trim().toLowerCase();

/** Does `p` answer to `name`, at `org` when both sides name one? */
function answersTo(p: Person, name: string, org: string): boolean {
  const n = key(name);
  if (key(p.name) !== n && !p.aliases.some((a) => key(a) === n)) return false;
  return !org || !p.org || key(p.org) === key(org);
}

/** The person `name` (and `org`) names, or undefined. */
export function findPerson(doc: PeopleDoc, name: string, org = ""): Person | undefined {
  return doc.people.find((p) => answersTo(p, name, org));
}

/** A person's kept notes, newest first. */
export function keptNotes(p: Person): PersonNote[] {
  return p.notes.filter((n) => n.status === "kept").sort((a, b) => b.saidAt - a.saidAt);
}

/** The people with something kept — what a reader outside the report sees. */
export function knownPeople(doc: PeopleDoc): Person[] {
  return doc.people.filter((p) => p.notes.some((n) => n.status === "kept"));
}

export interface NewNote {
  name: string;
  org?: string;
  text: string;
  saidAt: number;
  recordingId?: string;
  atMs?: number;
  quote?: string;
  status: NoteStatus;
}

/** `p` with its kept notes cut to the newest MAX_NOTES_PER_PERSON. */
function capped(p: Person): Person {
  const kept = keptNotes(p);
  if (kept.length <= MAX_NOTES_PER_PERSON) return p;
  const drop = new Set(kept.slice(MAX_NOTES_PER_PERSON).map((n) => n.id));
  return { ...p, notes: p.notes.filter((n) => !drop.has(n.id)) };
}

/**
 * `doc` with one more note, under the person it names (made when there is
 * none; an organisation fills in one that was unknown). A note whose text the
 * person already has is not added twice — a kept one stays kept, and a
 * candidate said again by hand becomes kept. Returns the document and the
 * person; the same document when the note is blank.
 */
export function withNote(doc: PeopleDoc, n: NewNote, now: number): { doc: PeopleDoc; person: Person | null } {
  const name = str(n.name, MAX_NAME_TEXT);
  const text = str(n.text, MAX_NOTE_TEXT);
  if (!name || !text) return { doc, person: null };
  const org = str(n.org, MAX_NAME_TEXT);
  const existing = findPerson(doc, name, org);
  const base: Person = existing ?? { id: crypto.randomUUID(), name, aliases: [], org, notes: [], updatedAt: now };
  const same = base.notes.find((x) => key(x.text) === key(text));
  let notes: PersonNote[];
  if (same) {
    if (same.status === "kept" || n.status === "candidate") return { doc, person: base };
    notes = base.notes.map((x) => (x === same ? { ...x, status: "kept" as const } : x));
  } else {
    const note: PersonNote = { id: crypto.randomUUID(), text, saidAt: n.saidAt, status: n.status, createdAt: now };
    if (n.recordingId) note.recordingId = n.recordingId;
    if (n.atMs !== undefined) note.atMs = n.atMs;
    const quote = str(n.quote, MAX_QUOTE_TEXT);
    if (quote) note.quote = quote;
    notes = [...base.notes, note];
  }
  const person = capped({ ...base, org: base.org || org, notes, updatedAt: now });
  const people = existing ? doc.people.map((p) => (p.id === person.id ? person : p)) : [...doc.people, person];
  return { doc: { ...doc, people }, person };
}

/** `doc` without one note; a person left with none is removed. The same
 *  document when there is no such note. */
export function withoutNote(doc: PeopleDoc, personId: string, noteId: string): PeopleDoc {
  const p = doc.people.find((x) => x.id === personId);
  if (!p?.notes.some((n) => n.id === noteId)) return doc;
  const notes = p.notes.filter((n) => n.id !== noteId);
  const people = notes.length
    ? doc.people.map((x) => (x.id === personId ? { ...x, notes } : x))
    : doc.people.filter((x) => x.id !== personId);
  return { ...doc, people };
}

/** `doc` with one candidate kept. */
export function withNoteKept(doc: PeopleDoc, personId: string, noteId: string, now: number): PeopleDoc {
  const people = doc.people.map((p) => {
    if (p.id !== personId || !p.notes.some((n) => n.id === noteId && n.status === "candidate")) return p;
    return capped({
      ...p,
      notes: p.notes.map((n) => (n.id === noteId ? { ...n, status: "kept" as const } : n)),
      updatedAt: now,
    });
  });
  return { ...doc, people };
}

/** One candidate with the person it is about. */
export interface Candidate {
  person: Pick<Person, "id" | "name" | "org">;
  note: PersonNote;
}

/** The candidates drawn from one recording, in the order they were said. */
export function candidatesFor(doc: PeopleDoc, recordingId: string): Candidate[] {
  const out: Candidate[] = [];
  for (const p of doc.people) {
    for (const note of p.notes) {
      if (note.status === "candidate" && note.recordingId === recordingId) {
        out.push({ person: { id: p.id, name: p.name, org: p.org }, note });
      }
    }
  }
  return out.sort((a, b) => (a.note.atMs ?? 0) - (b.note.atMs ?? 0));
}

/** `doc` with `recordingId` marked as read for candidates. */
export function withExtracted(doc: PeopleDoc, recordingId: string): PeopleDoc {
  if (doc.extracted.includes(recordingId)) return doc;
  return { ...doc, extracted: [...doc.extracted, recordingId].slice(-MAX_EXTRACTED) };
}
