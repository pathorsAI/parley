import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  emptyPeople,
  findPerson,
  keptNotes,
  knownPeople,
  MAX_NOTES_PER_PERSON,
  normalizePeople,
  withExtracted,
  withNote,
  withNoteKept,
  withoutNote,
  type NewNote,
} from "./notes";

const NOW = 1_800_000_000_000;
const note = (over: Partial<NewNote> = {}): NewNote => ({
  name: "王小明",
  org: "Acme",
  text: "十二月要去北海道滑雪",
  saidAt: NOW - 1000,
  recordingId: "r1",
  atMs: 65_000,
  quote: "我們十二月要去北海道滑雪",
  status: "candidate",
  ...over,
});

describe("withNote", () => {
  it("makes the person on the first note and files later ones under them", () => {
    const one = withNote(emptyPeople(), note(), NOW);
    expect(one.person).toMatchObject({ name: "王小明", org: "Acme" });
    const two = withNote(one.doc, note({ name: " 王小明 ", org: "", text: "忙季在三月" }), NOW);
    expect(two.doc.people).toHaveLength(1);
    expect(two.doc.people[0].notes.map((n) => n.text)).toEqual(["十二月要去北海道滑雪", "忙季在三月"]);
    expect(two.doc.people[0].notes[0]).toMatchObject({ recordingId: "r1", atMs: 65_000, quote: "我們十二月要去北海道滑雪" });
  });

  it("tells two people with one name apart by organisation, and fills in an unknown one", () => {
    const a = withNote(emptyPeople(), note(), NOW).doc;
    const b = withNote(a, note({ org: "Globex", text: "剛搬到新竹" }), NOW).doc;
    expect(b.people.map((p) => p.org)).toEqual(["Acme", "Globex"]);
    const c = withNote(emptyPeople(), note({ org: "" }), NOW).doc;
    expect(withNote(c, note({ text: "剛換工作" }), NOW).doc.people).toMatchObject([{ org: "Acme" }]);
  });

  it("does not add the same text twice; saying a candidate again by hand keeps it", () => {
    const a = withNote(emptyPeople(), note(), NOW).doc;
    expect(withNote(a, note(), NOW).doc).toBe(a);
    const kept = withNote(a, note({ status: "kept" }), NOW).doc;
    expect(kept.people[0].notes).toMatchObject([{ status: "kept" }]);
    expect(withNote(kept, note(), NOW).doc).toBe(kept);
  });

  it("ignores a blank name or text", () => {
    expect(withNote(emptyPeople(), note({ name: " " }), NOW)).toEqual({ doc: emptyPeople(), person: null });
    expect(withNote(emptyPeople(), note({ text: "" }), NOW).person).toBeNull();
  });

  it("keeps the newest MAX_NOTES_PER_PERSON kept notes", () => {
    let doc = emptyPeople();
    for (let i = 0; i < MAX_NOTES_PER_PERSON + 3; i++) {
      doc = withNote(doc, note({ text: `note ${i}`, saidAt: NOW + i, status: "kept" }), NOW).doc;
    }
    const kept = keptNotes(doc.people[0]);
    expect(kept).toHaveLength(MAX_NOTES_PER_PERSON);
    expect(kept[0].text).toBe(`note ${MAX_NOTES_PER_PERSON + 2}`);
    expect(kept.some((n) => n.text === "note 0")).toBe(false);
  });
});

describe("candidates", () => {
  const doc = withNote(withNote(emptyPeople(), note(), NOW).doc, note({ name: "Ann", org: "", text: "Moving in March", atMs: 5000 }), NOW).doc;

  it("are listed per recording in the order they were said, and hidden from outside readers", () => {
    expect(candidatesFor(doc, "r1").map((c) => c.person.name)).toEqual(["Ann", "王小明"]);
    expect(candidatesFor(doc, "r2")).toEqual([]);
    expect(knownPeople(doc)).toEqual([]);
  });

  it("a kept one is known; a dropped one is gone, and its person with it", () => {
    const [ann, wang] = candidatesFor(doc, "r1");
    const kept = withNoteKept(doc, wang.person.id, wang.note.id, NOW);
    expect(knownPeople(kept).map((p) => p.name)).toEqual(["王小明"]);
    expect(candidatesFor(kept, "r1")).toHaveLength(1);
    const dropped = withoutNote(kept, ann.person.id, ann.note.id);
    expect(dropped.people.map((p) => p.name)).toEqual(["王小明"]);
    expect(withoutNote(dropped, "nope", "nope")).toBe(dropped);
  });
});

describe("findPerson", () => {
  it("matches a name or an alias whatever the case", () => {
    const doc = normalizePeople({
      people: [{ id: "p1", name: "Ann Lee", aliases: ["Annie"], org: "Acme", notes: [{ id: "n1", text: "x", saidAt: 1, status: "kept", createdAt: 1 }] }],
    });
    expect(findPerson(doc, "ann lee")?.id).toBe("p1");
    expect(findPerson(doc, "ANNIE", "acme")?.id).toBe("p1");
    expect(findPerson(doc, "Annie", "Globex")).toBeUndefined();
  });
});

describe("normalizePeople", () => {
  it("reads a missing or malformed file as empty and drops what it cannot use", () => {
    expect(normalizePeople(null)).toEqual(emptyPeople());
    const doc = normalizePeople({
      people: [
        { id: "p1", name: "Ann", notes: [{ id: "n1", text: " hi ", status: "weird" }, { text: "no id" }] },
        { id: "p2", name: "Empty", notes: [] },
        { name: "No id", notes: [{ id: "n", text: "x" }] },
        7,
      ],
      extracted: ["r1", 3],
    });
    expect(doc.people).toEqual([
      { id: "p1", name: "Ann", aliases: [], org: "", updatedAt: 0, notes: [{ id: "n1", text: "hi", saidAt: 0, status: "kept", createdAt: 0 }] },
    ]);
    expect(doc.extracted).toEqual(["r1"]);
  });

  it("remembers a recording as read once", () => {
    const a = withExtracted(emptyPeople(), "r1");
    expect(withExtracted(a, "r1")).toBe(a);
  });
});
