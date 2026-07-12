import { describe, expect, it } from "vitest";
import {
  isValidCustomStageId,
  parseBundleFile,
  stageOrder,
  type CustomStageDef,
  type StageBundle,
} from "./bundleFile";
import { SALES_STAGES } from "./types";

function bundle(stage: string, over: Partial<StageBundle> = {}): StageBundle {
  return {
    stage,
    boardTitle: "板",
    slots: [{ id: `${stage}.x`, label: "X", hint: "h", query: { categories: [] } }],
    exitCriteria: ["done"],
    coachRules: [],
    ...over,
  };
}

function custom(id: string, over: Partial<CustomStageDef> = {}): CustomStageDef {
  return { id, name: `${id} 板`, bundle: bundle(id), ...over };
}

describe("parseBundleFile — v2", () => {
  it("v1 files keep parsing (overrides only, no custom stages)", () => {
    const raw = JSON.stringify({ version: 1, overrides: { discovery: bundle("discovery") } });
    const out = parseBundleFile(raw);
    expect(out.customStages).toEqual([]);
    expect(out.overrides.discovery?.boardTitle).toBe("板");
  });

  it("parses a valid custom stage and stamps stage/name into its bundle", () => {
    const raw = JSON.stringify({ version: 2, stages: [custom("coldcall")] });
    const out = parseBundleFile(raw);
    expect(out.customStages).toHaveLength(1);
    expect(out.customStages[0].bundle.stage).toBe("coldcall");
    expect(out.customStages[0].bundle.name).toBe("coldcall 板");
  });

  it("drops custom stages with bad ids: dots, uppercase, builtin shadow", () => {
    const raw = JSON.stringify({
      version: 2,
      stages: [
        custom("cold.call"),
        custom("ColdCall"),
        { ...custom("discovery"), id: "discovery" },
        custom("ok-stage"),
      ],
    });
    expect(parseBundleFile(raw).customStages.map((c) => c.id)).toEqual(["ok-stage"]);
  });

  it("drops custom stages whose slot ids don't carry the stage prefix", () => {
    const bad = custom("coldcall");
    bad.bundle.slots = [{ id: "other.x", label: "X", hint: "h", query: { categories: [] } }];
    const raw = JSON.stringify({ version: 2, stages: [bad] });
    expect(parseBundleFile(raw).customStages).toEqual([]);
  });

  it("first definition of a duplicated custom id wins", () => {
    const a = custom("coldcall", { name: "第一" });
    const b = custom("coldcall", { name: "第二" });
    const raw = JSON.stringify({ version: 2, stages: [a, b] });
    const out = parseBundleFile(raw);
    expect(out.customStages).toHaveLength(1);
    expect(out.customStages[0].name).toBe("第一");
  });

  it("accepts overrides keyed to custom stages, drops unknown/mismatched ones", () => {
    const raw = JSON.stringify({
      version: 2,
      stages: [custom("coldcall")],
      overrides: {
        coldcall: bundle("coldcall", { boardTitle: "改" }),
        bogus: bundle("bogus"),
        demo: bundle("discovery"), // demo override with discovery-prefixed slots → mismatch
      },
    });
    const out = parseBundleFile(raw);
    expect(out.overrides.coldcall?.boardTitle).toBe("改");
    expect(out.overrides.bogus).toBeUndefined();
    expect(out.overrides.demo).toBeUndefined();
  });

  it("empty / broken json → empty file", () => {
    expect(parseBundleFile("")).toEqual({ customStages: [], overrides: {} });
    expect(parseBundleFile("{ not json").customStages).toEqual([]);
  });
});

describe("stageOrder", () => {
  it("splices custom stages after their anchor; unknown anchor appends", () => {
    const order = stageOrder([
      custom("coldcall", { insertAfter: undefined }), // append
      custom("poc", { insertAfter: "demo" }),
      custom("lost-anchor", { insertAfter: "nope" }),
    ]);
    expect(order.indexOf("poc")).toBe(order.indexOf("demo") + 1);
    expect(order.slice(0, SALES_STAGES.length)[0]).toBe("prospecting");
    expect(order[order.length - 1]).toBe("lost-anchor");
    expect(order).toContain("coldcall");
  });

  it("a custom stage can anchor another custom stage", () => {
    const order = stageOrder([
      custom("coldcall", { insertAfter: "prospecting" }),
      custom("warmup", { insertAfter: "coldcall" }),
    ]);
    expect(order.indexOf("warmup")).toBe(order.indexOf("coldcall") + 1);
  });
});

describe("isValidCustomStageId", () => {
  it("slug only, no dots, no builtin shadowing", () => {
    expect(isValidCustomStageId("cold-call2")).toBe(true);
    expect(isValidCustomStageId("2cold")).toBe(false);
    expect(isValidCustomStageId("cold.call")).toBe(false);
    expect(isValidCustomStageId("closing")).toBe(false);
  });
});
