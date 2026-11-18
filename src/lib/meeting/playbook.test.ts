import { describe, expect, it } from "vitest";
import {
  emptyPlaybook,
  isPlaybookEmpty,
  MAX_PLAYBOOK_ITEMS,
  MAX_PLAYBOOK_TEXT,
  normalizePlaybook,
  playbookFromLists,
  playbookWithEdit,
  playbookWithItem,
  playbookWithoutItem,
  type MeetingPlaybook,
} from "./playbook";

const PB: MeetingPlaybook = {
  questions: [{ id: "q1", text: "Budget?" }],
  branches: [{ id: "b1", when: "too expensive", then: "Ask what they compare against" }],
  topics: [{ id: "t1", text: "Expansion" }],
};

describe("normalizePlaybook", () => {
  it("reads anything that is not an object as the empty playbook", () => {
    for (const raw of [undefined, null, "x", 3, []]) expect(normalizePlaybook(raw)).toEqual(emptyPlaybook());
  });

  it("keeps a well-formed playbook as it is", () => {
    expect(normalizePlaybook(PB)).toEqual(PB);
  });

  it("fills missing lists, drops blanks and non-objects, trims and caps text", () => {
    const long = "字".repeat(MAX_PLAYBOOK_TEXT + 10);
    const out = normalizePlaybook({
      questions: [{ id: "q1", text: "  Budget?  " }, { id: "q2", text: "   " }, null, "bare string", { id: "q3", text: long }],
      branches: [{ id: "b1", when: "x", then: "" }, { id: "b2", when: 1, then: "y" }],
    });
    expect(out.questions).toEqual([
      { id: "q1", text: "Budget?" },
      { id: "q3", text: "字".repeat(MAX_PLAYBOOK_TEXT) },
    ]);
    expect(out.branches).toEqual([]);
    expect(out.topics).toEqual([]);
  });

  it("mints an id when it is missing, empty, not a string or too long", () => {
    const out = normalizePlaybook({
      topics: [{ text: "a" }, { id: "", text: "b" }, { id: 7, text: "c" }, { id: "x".repeat(129), text: "d" }],
    });
    for (const t of out.topics) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.id.length).toBeLessThanOrEqual(128);
    }
    expect(new Set(out.topics.map((t) => t.id)).size).toBe(4);
  });

  it("caps each list", () => {
    const many = Array.from({ length: MAX_PLAYBOOK_ITEMS + 5 }, (_, i) => ({ id: `q${i}`, text: `q${i}` }));
    expect(normalizePlaybook({ questions: many }).questions).toHaveLength(MAX_PLAYBOOK_ITEMS);
  });
});

describe("isPlaybookEmpty", () => {
  it("is true for the empty playbook and for none at all", () => {
    expect(isPlaybookEmpty(emptyPlaybook())).toBe(true);
    expect(isPlaybookEmpty(null)).toBe(true);
    expect(isPlaybookEmpty(undefined)).toBe(true);
    expect(isPlaybookEmpty({ ...emptyPlaybook(), topics: PB.topics })).toBe(false);
  });
});

describe("playbookFromLists", () => {
  it("builds items from plain strings and pairs, dropping blanks", () => {
    const out = playbookFromLists({
      questions: ["  a  ", ""],
      branches: [{ when: "w", then: "t" }, { when: "", then: "t" }],
      topics: null,
    });
    expect(out.questions.map((q) => q.text)).toEqual(["a"]);
    expect(out.branches.map(({ when, then }) => ({ when, then }))).toEqual([{ when: "w", then: "t" }]);
    expect(out.topics).toEqual([]);
  });
});

describe("editing", () => {
  it("adds a trimmed item with a fresh id, refusing blanks, half branches and a full list", () => {
    const p = playbookWithItem(PB, "questions", { text: "  Timeline?  " });
    expect(p.questions.map((q) => q.text)).toEqual(["Budget?", "Timeline?"]);
    expect(p.questions[1].id).not.toBe("q1");
    expect(playbookWithItem(PB, "topics", { text: "  " })).toBe(PB);
    expect(playbookWithItem(PB, "branches", { when: "x" })).toBe(PB);
    expect(playbookWithItem(PB, "branches", { when: " x ", then: " y " }).branches[1]).toMatchObject({ when: "x", then: "y" });
    const full = { ...PB, topics: Array.from({ length: MAX_PLAYBOOK_ITEMS }, (_, i) => ({ id: `t${i}`, text: "t" })) };
    expect(playbookWithItem(full, "topics", { text: "one more" })).toBe(full);
  });

  it("edits an item in place; blanking it removes it", () => {
    expect(playbookWithEdit(PB, "questions", "q1", { text: " Budget range? " }).questions).toEqual([
      { id: "q1", text: "Budget range?" },
    ]);
    expect(playbookWithEdit(PB, "branches", "b1", { then: "Ask for their numbers" }).branches).toEqual([
      { id: "b1", when: "too expensive", then: "Ask for their numbers" },
    ]);
    expect(playbookWithEdit(PB, "topics", "t1", { text: "" }).topics).toEqual([]);
    expect(playbookWithEdit(PB, "branches", "b1", { when: " " }).branches).toEqual([]);
  });

  it("removes by id, leaving the other lists alone", () => {
    const p = playbookWithoutItem(PB, "branches", "b1");
    expect(p.branches).toEqual([]);
    expect(p.questions).toBe(PB.questions);
  });
});
