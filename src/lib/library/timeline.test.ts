import { describe, expect, it } from "vitest";
import { bucketFor, bucketKey, groupByDate, type DatedRecording } from "./timeline";

/**
 * Every timestamp here is built with the local-time `Date` constructor, so the
 * suite says the same thing in Taipei and in CI's UTC — the boundaries under
 * test are local midnights, not UTC ones.
 */
const at = (year: number, month: number, day: number, hour = 12, min = 0) =>
  new Date(year, month, day, hour, min).getTime();

/** Friday 4 Sep 2026, mid-afternoon. That week's Monday is 31 Aug. */
const FRIDAY = at(2026, 8, 4, 15);

describe("bucketFor", () => {
  it("puts everything from today in today, right down to midnight", () => {
    expect(bucketFor(FRIDAY, FRIDAY)).toEqual({ kind: "today" });
    expect(bucketFor(at(2026, 8, 4, 0, 0), FRIDAY)).toEqual({ kind: "today" });
    expect(bucketFor(at(2026, 8, 4, 23, 59), FRIDAY)).toEqual({ kind: "today" });
  });

  it("keeps a clock-skewed future timestamp in today rather than dropping it", () => {
    expect(bucketFor(at(2026, 8, 5, 9), FRIDAY)).toEqual({ kind: "today" });
  });

  it("splits yesterday off from the rest of the week", () => {
    expect(bucketFor(at(2026, 8, 3, 23, 59), FRIDAY)).toEqual({ kind: "yesterday" });
    expect(bucketFor(at(2026, 8, 3, 0, 0), FRIDAY)).toEqual({ kind: "yesterday" });
    expect(bucketFor(at(2026, 8, 2, 23, 59), FRIDAY)).toEqual({ kind: "thisWeek" });
  });

  it("runs the week back to Monday, not Sunday", () => {
    // Mon 31 Aug is in the same week as Fri 4 Sep; the Sunday before is not.
    expect(bucketFor(at(2026, 7, 31, 0, 0), FRIDAY)).toEqual({ kind: "thisWeek" });
    expect(bucketFor(at(2026, 7, 30, 23, 59), FRIDAY)).toEqual({
      kind: "month",
      year: 2026,
      month: 7,
    });
  });

  it("lets yesterday outrank the week boundary on a Monday", () => {
    const monday = at(2026, 7, 31, 10);
    expect(bucketFor(at(2026, 7, 30, 16), monday)).toEqual({ kind: "yesterday" });
  });

  it("gathers older recordings by calendar month", () => {
    expect(bucketFor(at(2026, 6, 2, 9), FRIDAY)).toEqual({ kind: "month", year: 2026, month: 6 });
    expect(bucketFor(at(2025, 11, 24, 9), FRIDAY)).toEqual({
      kind: "month",
      year: 2025,
      month: 11,
    });
  });
});

describe("bucketKey", () => {
  it("separates the same month in different years", () => {
    expect(bucketKey({ kind: "month", year: 2026, month: 7 })).not.toBe(
      bucketKey({ kind: "month", year: 2025, month: 7 })
    );
  });

  it("is stable for the fixed buckets", () => {
    expect(bucketKey({ kind: "today" })).toBe("today");
    expect(bucketKey({ kind: "yesterday" })).toBe("yesterday");
    expect(bucketKey({ kind: "thisWeek" })).toBe("thisWeek");
  });
});

describe("groupByDate", () => {
  const entries: DatedRecording[] = [
    { createdAt: at(2026, 7, 30, 15) }, // Sun 30 Aug → August
    { createdAt: at(2026, 8, 4, 9) }, // today, morning
    { createdAt: at(2026, 6, 11, 9) }, // July
    { createdAt: at(2026, 8, 2, 10) }, // Wed → this week
    { createdAt: at(2026, 8, 4, 14) }, // today, afternoon
    { createdAt: at(2026, 8, 3, 16) }, // Thu → yesterday
    { createdAt: at(2026, 7, 12, 9) }, // August
  ];

  const groups = groupByDate(entries, FRIDAY);

  it("orders the groups newest first", () => {
    expect(groups.map((g) => g.key)).toEqual([
      "today",
      "yesterday",
      "thisWeek",
      "month:2026-7",
      "month:2026-6",
    ]);
  });

  it("orders the items inside a group newest first, whatever order they arrived in", () => {
    const today = groups[0].items.map((e) => e.createdAt);
    expect(today).toEqual([at(2026, 8, 4, 14), at(2026, 8, 4, 9)]);
  });

  it("keeps every recording exactly once", () => {
    const placed = groups.flatMap((g) => g.items);
    expect(placed).toHaveLength(entries.length);
    expect(new Set(placed.map((e) => e.createdAt)).size).toBe(
      new Set(entries.map((e) => e.createdAt)).size
    );
  });

  it("has no empty groups", () => {
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
  });

  it("returns nothing for nothing", () => {
    expect(groupByDate([], FRIDAY)).toEqual([]);
  });
});
