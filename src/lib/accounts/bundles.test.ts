import { describe, expect, it, vi } from "vitest";

// parseOverrides logs a warning on its defensive paths, and `log`'s Tauri-less
// branch touches `window` (absent in the node test env). We don't test logging
// — it's a side-channel boundary — so stub the module to a no-op.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { translate, type TranslationKey } from "../../i18n/messages";
import {
  buildBuiltinBundles,
  mergeBundles,
  parseOverrides,
  stageBundles,
  type StageBundle,
} from "./bundles";
import { SALES_STAGES, type SalesStage } from "./types";

/** Real translator (zh-TW) so builtins resolve against the shipped copy — a
 *  missing i18n key falls back to the raw key, which the tests catch. */
const t = (key: string) => translate("zh-TW", key as TranslationKey);

/** A minimal well-formed override for one stage. */
function fakeBundle(stage: SalesStage, title: string): StageBundle {
  return {
    stage,
    boardTitle: title,
    slots: [{ id: `${stage}.x`, label: "X", hint: "h", query: { categories: [] } }],
    exitCriteria: ["done"],
    coachRules: [],
  };
}

describe("stage bundles — builtins", () => {
  const builtins = buildBuiltinBundles(t);

  it("ships one bundle per sales stage, prospecting first", () => {
    expect(SALES_STAGES[0]).toBe("prospecting");
    expect(Object.keys(builtins).sort()).toEqual([...SALES_STAGES].sort());
    for (const stage of SALES_STAGES) {
      expect(builtins[stage].stage).toBe(stage);
      expect(builtins[stage].slots.length).toBeGreaterThan(0);
      expect(builtins[stage].exitCriteria.length).toBeGreaterThan(0);
      expect(builtins[stage].coachRules.length).toBeGreaterThan(0);
    }
  });

  it("resolves all i18n copy (no raw keys leak into titles / labels / hints)", () => {
    for (const stage of SALES_STAGES) {
      const b = builtins[stage];
      expect(b.boardTitle).not.toMatch(/^accounts\./);
      for (const slot of b.slots) {
        expect(slot.label).not.toMatch(/^accounts\./);
        expect(slot.hint).not.toMatch(/^accounts\./);
      }
      for (const ex of b.exitCriteria) expect(ex).not.toMatch(/^accounts\./);
    }
  });

  it("gives prospecting its bespoke 5-slot callback board that guards the demo", () => {
    const p = builtins.prospecting;
    expect(p.slots.map((s) => s.id)).toEqual([
      "prospecting.identity",
      "prospecting.trigger",
      "prospecting.pain",
      "prospecting.impact",
      "prospecting.next",
    ]);
    // The whole call optimizes for ONE outcome — a booked demo — so it caps
    // rep talk time and blocks a premature jump to the demo.
    expect(p.coachRules.some((r) => r.kind === "talk-ratio")).toBe(true);
    expect(p.coachRules.some((r) => r.kind === "premature-demo")).toBe(true);
  });

  it("gives discovery a SPIN board (S13 letters) with s-tax and spin-order rules", () => {
    const d = builtins.discovery;
    expect(d.slots.map((s) => s.label)).toEqual([
      "S（情境）",
      "P（問題）",
      "I（影響）",
      "N（效益）",
      expect.any(String), // committee label resolved from i18n
    ]);
    expect(d.coachRules.some((r) => r.kind === "s-tax")).toBe(true);
    expect(d.coachRules.some((r) => r.kind === "spin-order")).toBe(true);
  });

  it("inverts the listening ratio for the demo (rep talks more) and polices open questions", () => {
    const talk = builtins.demo.coachRules.find((r) => r.kind === "talk-ratio");
    expect(talk).toMatchObject({ meMinPct: 55 });
    expect(builtins.demo.coachRules.some((r) => r.kind === "open-question")).toBe(true);
  });

  it("coarse-converts the remaining stages: one slot per collect line, label = hint = line", () => {
    for (const stage of ["demo", "negotiation", "closing"] as const) {
      const lines = t(`accounts.stageGuide.${stage}.collect`)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      expect(builtins[stage].slots).toHaveLength(lines.length);
      builtins[stage].slots.forEach((slot, i) => {
        expect(slot.label).toBe(lines[i]);
        expect(slot.hint).toBe(lines[i]);
      });
    }
  });
});

describe("stage bundles — parseOverrides", () => {
  it("returns {} for empty, whitespace, non-JSON, or null content", () => {
    expect(parseOverrides("")).toEqual({});
    expect(parseOverrides("   \n ")).toEqual({});
    expect(parseOverrides("{ not json")).toEqual({});
    expect(parseOverrides("null")).toEqual({});
  });

  it("accepts a whole-stage override and stamps the stage field", () => {
    const file = JSON.stringify({
      version: 1,
      overrides: { discovery: { ...fakeBundle("discovery", "My board"), stage: "closing" } },
    });
    const out = parseOverrides(file);
    expect(out.discovery?.boardTitle).toBe("My board");
    // The key wins over any stray stage field inside the payload.
    expect(out.discovery?.stage).toBe("discovery");
  });

  it("drops a malformed override without discarding the valid ones", () => {
    const file = JSON.stringify({
      version: 1,
      overrides: {
        prospecting: { boardTitle: "broken", slots: "not-an-array" },
        closing: fakeBundle("closing", "Custom closing"),
      },
    });
    const out = parseOverrides(file);
    expect(out.prospecting).toBeUndefined();
    expect(out.closing?.boardTitle).toBe("Custom closing");
  });

  it("ignores overrides keyed to unknown stages", () => {
    const file = JSON.stringify({
      version: 1,
      overrides: { bogus: fakeBundle("discovery", "x") },
    });
    expect(parseOverrides(file)).toEqual({});
  });
});

describe("stage bundles — merge", () => {
  const builtins = buildBuiltinBundles(t);

  it("replaces an overridden stage whole and keeps the rest builtin (S9)", () => {
    const custom = fakeBundle("discovery", "Override board");
    const merged = mergeBundles(builtins, { discovery: custom });
    expect(merged.discovery).toBe(custom);
    expect(merged.prospecting).toBe(builtins.prospecting);
    expect(Object.keys(merged).sort()).toEqual([...SALES_STAGES].sort());
  });

  it("stageBundles() composes builtins + overrides in one call", () => {
    const custom = fakeBundle("closing", "One-shot closing");
    const merged = stageBundles(t, { closing: custom });
    expect(merged.closing).toBe(custom);
    expect(merged.demo.stage).toBe("demo");
  });
});
