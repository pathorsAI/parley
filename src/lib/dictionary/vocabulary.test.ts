import { describe, expect, it, vi } from "vitest";

// The module imports the Tauri bridge at load; these helpers never touch it.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { VOCABULARY_LIMIT, profileTerms, recognitionTerms } from "./index";

function profile(userName: string, userCompany = "") {
  return { userName, userCompany };
}

describe("profileTerms", () => {
  /** The Settings placeholder itself reads "王小明 / Ming". */
  it("splits a field holding several spellings, name before company", () => {
    expect(profileTerms(profile("王小明 / Ming", "東蜂科技"))).toEqual(["王小明", "Ming", "東蜂科技"]);
  });

  it("splits on full-width and CJK separators too", () => {
    expect(profileTerms(profile("王小明／Ming、小明", "東蜂科技，Dongfeng；DF;East|EB"))).toEqual([
      "王小明",
      "Ming",
      "小明",
      "東蜂科技",
      "Dongfeng",
      "DF",
      "East",
      "EB",
    ]);
  });

  it("keeps a multi-word name whole", () => {
    expect(profileTerms(profile("Jane Doe", "Acme Corp"))).toEqual(["Jane Doe", "Acme Corp"]);
  });

  it("trims, drops empties and over-long parts, and dedupes", () => {
    const prose = "a".repeat(41);
    expect(profileTerms(profile("  Ming  /  / Ming ", `${prose}, Ming, 東蜂科技`))).toEqual([
      "Ming",
      "東蜂科技",
    ]);
    // 40 code points is still a name; CJK counts per character, not per byte.
    const forty = "名".repeat(40);
    expect(profileTerms(profile(forty))).toEqual([forty]);
  });

  it("is empty for an empty profile", () => {
    expect(profileTerms(profile("", ""))).toEqual([]);
    expect(profileTerms(profile("   ", " / "))).toEqual([]);
  });
});

describe("recognitionTerms", () => {
  it("puts profile terms first and does not repeat one the dictionary also has", () => {
    expect(recognitionTerms(profile("王小明", "東蜂科技"), ["Parley", "王小明"])).toEqual([
      "王小明",
      "東蜂科技",
      "Parley",
    ]);
  });

  it("keeps the profile terms when the dictionary fills the cap", () => {
    const dictionary = Array.from({ length: VOCABULARY_LIMIT + 10 }, (_, i) => `term${i}`);
    const terms = recognitionTerms(profile("王小明 / Ming", "東蜂科技"), dictionary);
    expect(terms).toHaveLength(VOCABULARY_LIMIT);
    expect(terms.slice(0, 3)).toEqual(["王小明", "Ming", "東蜂科技"]);
    // The newest dictionary terms stay; the oldest drop out to make room.
    expect(terms).toContain("term0");
    expect(terms).not.toContain(`term${VOCABULARY_LIMIT - 3}`);
  });

  it("returns the dictionary unchanged for an empty profile", () => {
    expect(recognitionTerms(profile(""), ["Parley", "派斯科技"])).toEqual(["Parley", "派斯科技"]);
  });

  it("defaults to this window's dictionary (empty before hydration)", () => {
    expect(recognitionTerms(profile("Ming"))).toEqual(["Ming"]);
  });
});
