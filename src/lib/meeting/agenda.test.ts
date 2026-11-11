import { describe, expect, it } from "vitest";
import {
  AGENDA_REMINDER_LEAD_MS,
  agendaCount,
  agendaProgress,
  agendaReminderDue,
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

describe("agendaProgress", () => {
  it("counts, fills and names the first item still open", () => {
    const p = agendaProgress([item("a", BUDGET, { done: true }), item("b", TIMELINE), item("c", PILOT)]);
    expect(p).toMatchObject({ done: 1, total: 3, next: { id: "b" } });
    expect(p.fraction).toBeCloseTo(1 / 3);
    expect(agendaCount(p)).toBe("1/3");
  });

  it("the next item is the first open one in agenda order, not the first ticked off", () => {
    const p = agendaProgress([item("a", BUDGET), item("b", TIMELINE, { done: true })]);
    expect(p.next?.id).toBe("a");
  });

  it("has no next item once everything is done, and an empty agenda fills nothing", () => {
    expect(agendaProgress([item("a", BUDGET, { done: true })])).toMatchObject({ next: null, fraction: 1 });
    expect(agendaProgress([])).toEqual({ done: 0, total: 0, fraction: 0, next: null });
  });
});

describe("agendaReminderDue", () => {
  const END = 10_000_000;
  const open = [item("a", BUDGET, { done: true }), item("b", TIMELINE)];
  const due = (over: Partial<Parameters<typeof agendaReminderDue>[0]>) =>
    agendaReminderDue({ now: END - AGENDA_REMINDER_LEAD_MS, meetingEndAt: END, todos: open, alreadyShown: false, ...over });

  it("fires from five minutes before the drafted end while something is open", () => {
    expect(due({})).toBe(true);
    expect(due({ now: END + 60_000 })).toBe(true);
  });

  it("waits until then", () => {
    expect(due({ now: END - AGENDA_REMINDER_LEAD_MS - 1 })).toBe(false);
  });

  it("never without an end time, once shown, or with nothing open", () => {
    expect(due({ meetingEndAt: null })).toBe(false);
    expect(due({ alreadyShown: true })).toBe(false);
    expect(due({ todos: [item("a", BUDGET, { done: true })] })).toBe(false);
    expect(due({ todos: [] })).toBe(false);
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
    });
  });
});
