import { describe, expect, it } from "vitest";
import { fromLocalInput, toLocalInput } from "./MeetingDraftSheet";

describe("draft time input", () => {
  it("round-trips a local minute", () => {
    const ms = new Date(2026, 9, 30, 14, 30).getTime();
    expect(toLocalInput(ms)).toBe("2026-10-30T14:30");
    expect(fromLocalInput("2026-10-30T14:30")).toBe(ms);
  });

  it("reads an empty or broken value as no time", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("not a date")).toBeNull();
  });
});
