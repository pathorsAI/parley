import { describe, expect, it } from "vitest";
import { normalizeBriefHeadings, splitBrief } from "./briefSections";

const DECISION = [
  "## Highlights",
  "- 第一波先打 2,000 筆 [0:40]",
  "",
  "## Decisions",
  "- 只排平日 [2:00]",
  "",
  "## Open questions",
  "- 上線日期 [4:22]",
  "",
  "## Suggested next agenda",
  "- 確認名單欄位",
].join("\n");

describe("splitBrief", () => {
  it("cuts at the headings and moves the next-agenda section out of the summary", () => {
    const split = splitBrief(DECISION);
    expect(split.sections.map((s) => s.key)).toEqual(["highlights", "decisions", "openQuestions"]);
    expect(split.sections[1].body).toBe("- 只排平日 [2:00]");
    expect(split.next.map((s) => s.key)).toEqual(["nextAgenda"]);
    expect(split.lead).toBe("");
  });

  it("matches headings with trailing spaces, a colon or another case", () => {
    const split = splitBrief("## highlights  \n- a\n## Next Steps:\n- b");
    expect(split.sections.map((s) => s.key)).toEqual(["highlights"]);
    expect(split.next.map((s) => s.key)).toEqual(["nextSteps"]);
  });

  it("keeps a heading it doesn't know, under its own title", () => {
    const split = splitBrief("## 其他\n- c");
    expect(split.sections).toEqual([{ key: null, title: "其他", body: "- c" }]);
  });

  it("drops empty sections and keeps text before the first heading as the lead", () => {
    const split = splitBrief("前言\n## Highlights\n\n## Decisions\n- d");
    expect(split.lead).toBe("前言");
    expect(split.sections.map((s) => s.key)).toEqual(["decisions"]);
  });

  it("returns a brief without headings as its lead alone", () => {
    expect(splitBrief("只有一段文字")).toEqual({ lead: "只有一段文字", sections: [], next: [] });
  });
});

describe("normalizeBriefHeadings", () => {
  it("unwraps bolded headings, and the brief then cuts as usual", () => {
    const md = "**## Highlights**\n- a\n**## Decisions**  \n- b\n__## Open questions__\n- c";
    expect(normalizeBriefHeadings(md)).toBe("## Highlights\n- a\n## Decisions\n- b\n## Open questions\n- c");
    expect(splitBrief(md).sections.map((s) => s.key)).toEqual(["highlights", "decisions", "openQuestions"]);
  });
  it("leaves ordinary bold text alone", () => {
    expect(normalizeBriefHeadings("- **Channel** 欄位")).toBe("- **Channel** 欄位");
  });
});
