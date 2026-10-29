import { describe, expect, it } from "vitest";
import { autoMeetingTitle, retitleForTime } from "./draftTitle";

const at = new Date(2026, 9, 31, 14, 0).getTime();
const later = new Date(2026, 10, 2, 9, 30).getTime();

describe("autoMeetingTitle", () => {
  it("names the meeting after its time in each language", () => {
    expect(autoMeetingTitle(at, "zh-TW")).toContain("14:00");
    expect(autoMeetingTitle(at, "zh-TW")).toMatch(/會議$/);
    expect(autoMeetingTitle(at, "en")).toMatch(/^Meeting .*2:00/);
  });
});

describe("retitleForTime", () => {
  it("prefills a blank title when a time is first set", () => {
    expect(retitleForTime("", null, at, "zh-TW")).toBe(autoMeetingTitle(at, "zh-TW"));
  });

  it("keeps a title the user wrote", () => {
    expect(retitleForTime("Pricing call", null, at, "en")).toBe("Pricing call");
    expect(retitleForTime("Pricing call", at, later, "en")).toBe("Pricing call");
  });

  it("moves the auto name along with the time", () => {
    expect(retitleForTime(autoMeetingTitle(at, "en"), at, later, "en")).toBe(autoMeetingTitle(later, "en"));
  });

  it("leaves a title the user cleared empty when the time moves", () => {
    expect(retitleForTime("", at, later, "zh-TW")).toBe("");
  });

  it("drops the auto name with the time", () => {
    expect(retitleForTime(autoMeetingTitle(at, "en"), at, null, "en")).toBe("");
  });
});
