import { describe, expect, it } from "vitest";
import { LATE_GRACE_MS, planReminder } from "./reminder";

const MIN = 60_000;
const at = Date.UTC(2026, 9, 30, 6, 0);

describe("planReminder", () => {
  it("does nothing without a time, or once it has fired for that time", () => {
    expect(planReminder({ meetingAt: null, leadMin: 5, remindedFor: null, now: at })).toEqual({ kind: "none" });
    expect(planReminder({ meetingAt: at, leadMin: 5, remindedFor: at, now: at - 5 * MIN })).toEqual({ kind: "none" });
  });

  it("waits until the lead before the start", () => {
    expect(planReminder({ meetingAt: at, leadMin: 5, remindedFor: null, now: at - 20 * MIN })).toEqual({
      kind: "wait",
      ms: 15 * MIN,
    });
  });

  it("fires at the lead, and still fires a little late", () => {
    expect(planReminder({ meetingAt: at, leadMin: 5, remindedFor: null, now: at - 5 * MIN })).toEqual({ kind: "fire" });
    expect(planReminder({ meetingAt: at, leadMin: 0, remindedFor: null, now: at + 3 * MIN })).toEqual({ kind: "fire" });
  });

  it("gives up once the meeting is well under way", () => {
    expect(planReminder({ meetingAt: at, leadMin: 5, remindedFor: null, now: at + LATE_GRACE_MS + 1 })).toEqual({
      kind: "none",
    });
  });

  it("re-plans a far-off reminder after a day rather than one huge timer", () => {
    const plan = planReminder({ meetingAt: at, leadMin: 5, remindedFor: null, now: at - 40 * 24 * 60 * MIN });
    expect(plan).toEqual({ kind: "wait", ms: 24 * 60 * MIN });
  });

  it("remembers a reminder fired for an earlier time doesn't cover a new one", () => {
    const earlier = at - 60 * MIN;
    expect(planReminder({ meetingAt: at, leadMin: 5, remindedFor: earlier, now: at - 5 * MIN })).toEqual({
      kind: "fire",
    });
  });
});
