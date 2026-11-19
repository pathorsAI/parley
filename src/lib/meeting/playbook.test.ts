import { describe, expect, it } from "vitest";
import {
  emptyPlaybook,
  isPlaybookEmpty,
  legacyQuestions,
  MAX_PLAYBOOK_ITEMS,
  MAX_PLAYBOOK_TEXT,
  normalizePlaybook,
  playbookFromLists,
  playbookWithItem,
  playbookWithoutItem,
  withLegacyQuestions,
  type MeetingPlaybook,
} from "./playbook";
import type { TodoItem } from "../types";

const PB: MeetingPlaybook = {
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
      topics: [{ id: "t1", text: "  Budget  " }, { id: "t2", text: "   " }, null, "bare string", { id: "t3", text: long }],
      branches: [{ id: "b1", when: "x", then: "" }, { id: "b2", when: 1, then: "y" }],
    });
    expect(out.topics).toEqual([
      { id: "t1", text: "Budget" },
      { id: "t3", text: "字".repeat(MAX_PLAYBOOK_TEXT) },
    ]);
    expect(out.branches).toEqual([]);
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
    expect(normalizePlaybook({ topics: many }).topics).toHaveLength(MAX_PLAYBOOK_ITEMS);
  });

  it("drops a legacy questions list", () => {
    expect(normalizePlaybook({ ...PB, questions: [{ id: "q1", text: "Budget?" }] })).toEqual(PB);
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
      branches: [{ when: "w", then: "t" }, { when: "", then: "t" }],
      topics: ["  a  ", ""],
    });
    expect(out.branches.map(({ when, then }) => ({ when, then }))).toEqual([{ when: "w", then: "t" }]);
    expect(out.topics.map((t) => t.text)).toEqual(["a"]);
    expect(playbookFromLists({ topics: null })).toEqual(emptyPlaybook());
  });
});

describe("editing", () => {
  it("adds a trimmed item with a fresh id, refusing blanks, half branches and a full list", () => {
    const p = playbookWithItem(PB, "topics", { text: "  Timeline  " });
    expect(p.topics.map((t) => t.text)).toEqual(["Expansion", "Timeline"]);
    expect(p.topics[1].id).not.toBe("t1");
    expect(playbookWithItem(PB, "topics", { text: "  " })).toBe(PB);
    expect(playbookWithItem(PB, "branches", { when: "x" })).toBe(PB);
    expect(playbookWithItem(PB, "branches", { when: " x ", then: " y " }).branches[1]).toMatchObject({ when: "x", then: "y" });
    const full = { ...PB, topics: Array.from({ length: MAX_PLAYBOOK_ITEMS }, (_, i) => ({ id: `t${i}`, text: "t" })) };
    expect(playbookWithItem(full, "topics", { text: "one more" })).toBe(full);
  });

  it("removes by id, leaving the other lists alone", () => {
    const p = playbookWithoutItem(PB, "branches", "b1");
    expect(p.branches).toEqual([]);
    expect(p.topics).toBe(PB.topics);
  });
});

describe("legacy questions", () => {
  const todo = (id: string, text: string, done = false): TodoItem => ({ id, text, done });

  it("reads the question texts of a playbook that still has them", () => {
    expect(legacyQuestions({ questions: [{ id: "q1", text: "  Budget?  " }, { text: " " }, null, "x"] })).toEqual([
      "Budget?",
    ]);
    for (const raw of [undefined, null, "x", {}, { questions: "x" }, PB]) expect(legacyQuestions(raw)).toEqual([]);
  });

  it("folds them into the agenda as unticked items, skipping texts already there", () => {
    const todos = [todo("a1", " Budget? ", true)];
    const out = withLegacyQuestions(todos, {
      questions: [{ id: "q1", text: "Budget?" }, { id: "q2", text: "Timeline?" }, { id: "q3", text: "Timeline?" }],
    });
    expect(out).toEqual([todo("a1", " Budget? ", true), todo("q2", "Timeline?")]);
  });

  it("gives the same agenda on every read (stable ids), and the same array when nothing is added", () => {
    const raw = { questions: [{ text: "Budget?" }, { id: "q2", text: "Timeline?" }] };
    const first = withLegacyQuestions([], raw);
    expect(first.map((t) => t.id)).toEqual(["legacy-question-0", "q2"]);
    expect(withLegacyQuestions([], raw)).toEqual(first);
    const todos = [todo("a1", "x")];
    expect(withLegacyQuestions(todos, PB)).toBe(todos);
  });
});
