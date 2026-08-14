import { beforeEach, describe, expect, it, vi } from "vitest";

// parseOverrides logs a warning on its defensive paths, and `log`'s Tauri-less
// branch touches `window` (absent in the node test env). We don't test logging
// — it's a side-channel boundary — so stub the module to a no-op.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Non-Tauri branch: the bundle file is read/written through localStorage, which
// the node test env doesn't have. A tiny in-memory stand-in gives
// createBoardlessKind a real read→write→read round trip to be tested against.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

import { translate, type TranslationKey } from "../../i18n/messages";
import {
  buildBuiltinBundles,
  buildScenarioSet,
  BUILTIN_KIND_IDS,
  createBoardlessKind,
  mergeBundles,
  parseOverrides,
  readStageBundleFile,
  stageBundles,
  type StageBundle,
} from "./bundles";
import { EMPTY_BUNDLE_FILE, type CustomScenarioDef } from "./bundleFile";
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

// ── Boardless kinds ─────────────────────────────────────────────────────────

/** A zero-stage scenario: a name and an analysis lens, no board. */
function fakeKind(id: string, name: string): CustomScenarioDef {
  return { id, name, icon: "📋", guidance: "Look at what was decided.", stages: [] };
}

describe("scenario set — boardless kinds", () => {
  it("keeps a zero-stage scenario instead of filtering it away", () => {
    // The dropped-if-empty rule is exactly what made kinds unrepresentable:
    // a retro has nothing to put on a board, so it had no way to exist.
    const set = buildScenarioSet(t, {
      ...EMPTY_BUNDLE_FILE,
      customScenarios: [fakeKind("weekly", "Weekly sync")],
    });
    const weekly = set.byId.weekly;
    expect(weekly).toBeDefined();
    expect(weekly.hasBoard).toBe(false);
    expect(weekly.order).toEqual([]);
    expect(weekly.guidance).toBe("Look at what was decided.");
    expect(set.list.map((s) => s.id)).toContain("weekly");
  });

  it("ships retro + office hour as builtin kinds, and the board scenarios still have boards", () => {
    const set = buildScenarioSet(t, EMPTY_BUNDLE_FILE);
    for (const id of BUILTIN_KIND_IDS) {
      expect(set.byId[id].hasBoard).toBe(false);
      expect(set.byId[id].builtin).toBe(true);
      // Guidance is the kind's entire contribution — an empty one is a bug.
      expect(set.byId[id].guidance.length).toBeGreaterThan(100);
    }
    for (const id of ["sales", "negotiation", "partnership"]) {
      expect(set.byId[id].hasBoard).toBe(true);
      expect(set.byId[id].order.length).toBeGreaterThan(0);
    }
  });

  it("a scenario WITH stages still reports hasBoard", () => {
    const set = buildScenarioSet(t, {
      ...EMPTY_BUNDLE_FILE,
      customScenarios: [
        {
          id: "intake",
          name: "Intake",
          stages: [
            {
              id: "intake",
              name: "Intake",
              bundle: fakeBundle("intake" as SalesStage, "Intake board"),
            },
          ],
        },
      ],
    });
    expect(set.byId.intake.hasBoard).toBe(true);
  });
});

describe("createBoardlessKind", () => {
  beforeEach(() => storage.clear());

  it("appends a kind that survives a read back", async () => {
    await createBoardlessKind({
      id: "retro-eng",
      name: "Eng Retro",
      icon: "🔁",
      guidance: "Decisions, actions, blockers.",
    });
    const parsed = await readStageBundleFile({ fresh: true });
    expect(parsed.customScenarios).toHaveLength(1);
    expect(parsed.customScenarios[0]).toMatchObject({
      id: "retro-eng",
      name: "Eng Retro",
      icon: "🔁",
      stages: [],
    });
    expect(buildScenarioSet(t, parsed).byId["retro-eng"].hasBoard).toBe(false);
  });

  it("is idempotent — a second call never duplicates or clobbers", async () => {
    await createBoardlessKind({ id: "onboarding", name: "Onboarding" });
    await createBoardlessKind({ id: "onboarding", name: "SOMETHING ELSE" });
    const parsed = await readStageBundleFile({ fresh: true });
    expect(parsed.customScenarios).toHaveLength(1);
    expect(parsed.customScenarios[0].name).toBe("Onboarding");
  });

  it("refuses an id that isn't a valid scenario slug, and writes nothing", async () => {
    for (const bad of ["Retro", "my kind", "sales", "retro", "general", "1on1"]) {
      await expect(createBoardlessKind({ id: bad, name: "X" })).rejects.toThrow(
        /invalid scenario id/
      );
    }
    expect((await readStageBundleFile({ fresh: true })).customScenarios).toHaveLength(0);
  });

  it("leaves an existing scenario's BOARD alone when the id collides", async () => {
    // Not just "doesn't duplicate": a user's authored board must survive an
    // MCP client blindly re-declaring the same id as a kind.
    const withBoard = {
      ...EMPTY_BUNDLE_FILE,
      customScenarios: [
        {
          id: "intake",
          name: "Intake",
          stages: [
            {
              id: "intake",
              name: "Intake",
              bundle: fakeBundle("intake" as SalesStage, "Intake board"),
            },
          ],
        },
      ],
    };
    const { writeStageBundleFile } = await import("./bundles");
    await writeStageBundleFile(withBoard);
    await createBoardlessKind({ id: "intake", name: "Intake" });
    const parsed = await readStageBundleFile({ fresh: true });
    expect(parsed.customScenarios).toHaveLength(1);
    expect(parsed.customScenarios[0].stages).toHaveLength(1);
    expect(buildScenarioSet(t, parsed).byId.intake.hasBoard).toBe(true);
  });
});
