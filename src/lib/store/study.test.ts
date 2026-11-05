import { describe, expect, it } from "vitest";
import { normalizeStudyTab, STUDY_TABS } from "./study";

describe("normalizeStudyTab", () => {
  it("keeps every current tab", () => {
    for (const tab of STUDY_TABS) expect(normalizeStudyTab(tab)).toBe(tab);
  });

  it("reads the old merged report page as the summary tab", () => {
    expect(normalizeStudyTab("report")).toBe("summary");
  });

  it("falls back to the summary for anything else", () => {
    expect(normalizeStudyTab("findings")).toBe("summary");
    expect(normalizeStudyTab(null)).toBe("summary");
    expect(normalizeStudyTab(undefined)).toBe("summary");
  });
});
