import { describe, expect, it } from "vitest";
import { durationParts, endSlots, monthGrid, nextHalfHour, onDay, startSlots } from "./timeSlots";

const at = (h: number, m: number, day = 30) => new Date(2026, 9, day, h, m).getTime();

describe("time slots", () => {
  it("offers a day's starts 15 minutes apart", () => {
    const slots = startSlots(at(14, 7));
    expect(slots).toHaveLength(96);
    expect(slots[0]).toBe(at(0, 0));
    expect(slots[57]).toBe(at(14, 15));
  });

  it("offers ends after the start, up to midnight", () => {
    const slots = endSlots(at(23, 0));
    expect(slots).toEqual([at(23, 15), at(23, 30), at(23, 45), at(0, 0, 31)]);
  });

  it("starts a new draft on the next half hour", () => {
    expect(nextHalfHour(at(14, 7))).toBe(at(14, 30));
    expect(nextHalfHour(at(14, 30))).toBe(at(15, 0));
    expect(nextHalfHour(at(23, 40))).toBe(at(0, 0, 31));
  });

  it("moves a time onto another day, keeping the clock", () => {
    expect(onDay(at(0, 0, 2), at(9, 45))).toBe(at(9, 45, 2));
  });

  it("says a length the way the calendar does", () => {
    expect(durationParts(45)).toEqual({ unit: "min", value: "45" });
    expect(durationParts(60)).toEqual({ unit: "hour", value: "1" });
    expect(durationParts(90)).toEqual({ unit: "hour", value: "1.5" });
    expect(durationParts(75)).toEqual({ unit: "hour", value: "1.25" });
  });

  it("lays a month out in six Sunday-first weeks", () => {
    const weeks = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(weeks).toHaveLength(6);
    expect(new Date(weeks[0][0]).getDay()).toBe(0);
    expect(new Date(weeks[0][4]).getDate()).toBe(1);
  });
});
