import { describe, expect, it } from "vitest";
import { splitBrief } from "../analysis/briefSections";
import type { HistoryEntry } from "../history/types";
import { refreshSampleOutputs } from "./sampleOutputs";
import zh from "./sampleManifests/sample.zh-TW.json";
import en from "./sampleManifests/sample.en.json";

const OLD_BRIEF = "**泓昇科技第一次需求訪談，銷售通話。** 對方……\n\n**進展：** ……";

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return { id: zh.id, brief: OLD_BRIEF, deliveryAssessment: null, ...over } as HistoryEntry;
}

describe("the sample's prewritten outputs", () => {
  it("are cut into the sales lens's sections, like a generated brief", () => {
    for (const m of [zh, en]) {
      const { sections, next } = splitBrief(m.brief);
      expect(sections.map((s) => s.key)).toEqual(["whereLanded", "painObjections", "unknowns"]);
      expect(next.map((s) => s.key)).toEqual(["nextSteps"]);
      expect(m.brief).not.toMatch(/\{L\d+\}/);
    }
  });

  it("carry a 評分 read", () => {
    expect(zh.delivery.summary).toBeTruthy();
    expect(en.delivery.tone).toBe("warm");
  });
});

describe("refreshSampleOutputs", () => {
  it("brings an old sample up to the current brief and 評分 read", () => {
    const next = refreshSampleOutputs(entry({}));
    expect(next.brief).toBe(zh.brief);
    expect(next.deliveryAssessment).toEqual(zh.delivery);
  });

  it("keeps a brief that already has sections, and an existing read", () => {
    const own = "## Where this landed\nmine";
    const read = { ...zh.delivery, summary: "mine" } as HistoryEntry["deliveryAssessment"];
    const kept = entry({ brief: own, deliveryAssessment: read });
    expect(refreshSampleOutputs(kept)).toBe(kept);
  });

  it("leaves other recordings alone", () => {
    const other = entry({ id: "abc" });
    expect(refreshSampleOutputs(other)).toBe(other);
  });
});
