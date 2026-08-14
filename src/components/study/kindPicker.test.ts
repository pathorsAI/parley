import { describe, it, expect } from "vitest";

import {
  pushRecentMeetingType,
  RECENT_MEETING_TYPES_MAX,
  slugifyKindId,
  sortByRecent,
} from "./kindPicker";

const list = [
  { id: "sales" },
  { id: "negotiation" },
  { id: "partnership" },
  { id: "retro" },
  { id: "officehour" },
];

describe("sortByRecent", () => {
  it("keeps the set's own order when nothing has been picked yet", () => {
    expect(sortByRecent(list, []).map((x) => x.id)).toEqual([
      "sales",
      "negotiation",
      "partnership",
      "retro",
      "officehour",
    ]);
  });

  it("pulls recent entries to the front, in recent order", () => {
    expect(sortByRecent(list, ["retro", "negotiation"]).map((x) => x.id)).toEqual([
      "retro",
      "negotiation",
      "sales",
      "partnership",
      "officehour",
    ]);
  });

  it("skips recent ids that no longer resolve", () => {
    // A deleted custom kind lingers in settings; it must not leave a hole.
    expect(sortByRecent(list, ["deleted-kind", "officehour"]).map((x) => x.id)).toEqual([
      "officehour",
      "sales",
      "negotiation",
      "partnership",
      "retro",
    ]);
  });

  it("never repeats an entry when recent has duplicates", () => {
    const out = sortByRecent(list, ["retro", "retro"]).map((x) => x.id);
    expect(out).toEqual(["retro", "sales", "negotiation", "partnership", "officehour"]);
  });

  it("does not mutate its inputs", () => {
    const original = [...list];
    sortByRecent(list, ["retro"]);
    expect(list).toEqual(original);
  });
});

describe("pushRecentMeetingType", () => {
  it("puts the pick first", () => {
    expect(pushRecentMeetingType([], "retro")).toEqual(["retro"]);
    expect(pushRecentMeetingType(["sales"], "retro")).toEqual(["retro", "sales"]);
  });

  it("de-duplicates instead of growing", () => {
    expect(pushRecentMeetingType(["sales", "retro"], "retro")).toEqual(["retro", "sales"]);
  });

  it("caps the list, dropping the least recent", () => {
    const full = Array.from({ length: RECENT_MEETING_TYPES_MAX }, (_, i) => `k${i}`);
    const next = pushRecentMeetingType(full, "new");
    expect(next).toHaveLength(RECENT_MEETING_TYPES_MAX);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`k${RECENT_MEETING_TYPES_MAX - 1}`);
  });
});

describe("slugifyKindId", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyKindId("Office Hour")).toBe("office-hour");
    expect(slugifyKindId("1:1")).toBe("1-1");
  });

  it("collapses runs and trims the edges", () => {
    expect(slugifyKindId("  Investor -- Update  ")).toBe("investor-update");
  });

  it("returns empty for a name with no Latin characters", () => {
    // The form asks for an explicit id in this case rather than inventing one.
    expect(slugifyKindId("回顧")).toBe("");
  });
});
