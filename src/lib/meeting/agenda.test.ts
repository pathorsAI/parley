import { describe, expect, it } from "vitest";
import {
  applyAiChecks,
  carryOverDraft,
  parseClock,
  toggleAgendaItem,
  uncoveredAgenda,
} from "./agenda";
import type { TodoItem } from "../types";

const BUDGET = "Confirm the budget";
const TIMELINE = "Agree the timeline";
const PILOT = "Scope the pilot";

function item(id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, text, done: false, ...extra };
}

describe("parseClock", () => {
  it("reads the transcript's m:ss, mm:ss and h:mm:ss stamps", () => {
    expect(parseClock("0:05")).toBe(5_000);
    expect(parseClock("3:12")).toBe(192_000);
    expect(parseClock("18:40")).toBe(1_120_000);
    expect(parseClock("1:02:03")).toBe(3_723_000);
  });

  it("tolerates the brackets and spaces the model copies from the transcript", () => {
    expect(parseClock("[3:12]")).toBe(192_000);
    expect(parseClock("  3:12 ")).toBe(192_000);
  });

  it("is undefined for anything that is not a time on the clock", () => {
    for (const bad of ["", "soon", "3", "3:7", "3:60", "1:60:00", "-1:00", "3:12pm", null, undefined]) {
      expect(parseClock(bad)).toBeUndefined();
    }
  });
});

describe("applyAiChecks", () => {
  it("ticks the named items as the AI's, at the line it named", () => {
    const next = applyAiChecks([item("a", BUDGET), item("b", TIMELINE), item("c", PILOT)], [
      { id: "a", atMs: 192_000 },
      { id: "b" },
    ]);
    expect(next[0]).toEqual({ id: "a", text: BUDGET, done: true, doneBy: "ai", doneAtMs: 192_000 });
    expect(next[1]).toEqual({ id: "b", text: TIMELINE, done: true, doneBy: "ai" });
    expect(next[2].done).toBe(false);
  });

  it("leaves an item the user dismissed, or already ticked, as it is", () => {
    const dismissed = item("a", BUDGET, { aiDismissed: true });
    const mine = item("b", TIMELINE, { done: true, doneBy: "user" });
    const next = applyAiChecks([dismissed, mine], [{ id: "a", atMs: 1_000 }, { id: "b", atMs: 2_000 }]);
    expect(next[0]).toBe(dismissed);
    expect(next[1]).toBe(mine);
  });
});

describe("toggleAgendaItem", () => {
  it("a user's tick is the user's, with no time point", () => {
    expect(toggleAgendaItem(item("a", BUDGET))).toEqual({ id: "a", text: BUDGET, done: true, doneBy: "user" });
  });

  it("unticking an AI tick dismisses it and drops who and where", () => {
    const ai = item("a", BUDGET, { done: true, doneBy: "ai", doneAtMs: 5_000 });
    expect(toggleAgendaItem(ai)).toEqual({ id: "a", text: BUDGET, done: false, aiDismissed: true });
  });

  it("unticking the user's own tick dismisses nothing", () => {
    const mine = item("a", BUDGET, { done: true, doneBy: "user" });
    expect(toggleAgendaItem(mine)).toEqual({ id: "a", text: BUDGET, done: false });
  });

  it("a dismissed item ticked again by the user stays dismissed", () => {
    const back = toggleAgendaItem(item("a", BUDGET, { aiDismissed: true }));
    expect(back).toMatchObject({ done: true, doneBy: "user", aiDismissed: true });
  });
});

describe("uncoveredAgenda", () => {
  it("keeps the items not done, in order, and nothing for a missing agenda", () => {
    const agenda = [item("a", BUDGET, { done: true, doneBy: "ai" }), item("b", TIMELINE), item("c", " "), item("d", PILOT)];
    expect(uncoveredAgenda(agenda).map((t) => t.id)).toEqual(["b", "d"]);
    expect(uncoveredAgenda(undefined)).toEqual([]);
    expect(uncoveredAgenda([item("a", BUDGET, { done: true })])).toEqual([]);
  });
});

describe("carryOverDraft", () => {
  it("files the uncovered items as a fresh agenda under the title, everything else empty", () => {
    expect(carryOverDraft("Kickoff (follow-up)", [item("b", ` ${TIMELINE} `), item("d", PILOT)])).toEqual({
      title: "Kickoff (follow-up)",
      meetingAt: null,
      meetingEndAt: null,
      reminderLeadMin: null,
      meetingContext: "",
      meetingFolderId: null,
      agenda: [TIMELINE, PILOT],
      playbook: { branches: [], topics: [] },
      opening: { script: "", smallTalk: [] },
    });
  });
});
