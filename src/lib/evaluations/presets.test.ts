import { describe, it, expect } from "vitest";
import { buildPresetEvalTemplates, defaultEvalDefs, evalsFromDefs, findActiveTemplate } from "./presets";
import { EVAL_TEMPLATE_OF, MEETING_KINDS } from "../analysis/lens";
import type { EvalDef, Evaluation } from "../types";

// evalsFromDefs is the domain transform that turns persisted definitions into
// runtime evaluations, preserving in-flight state (status/result) by id across
// a settings edit. Contract: defs win for content, prev wins for runtime state.

const def = (id: string, name = id): EvalDef => ({
  id,
  name,
  description: `${id} desc`,
  prompt: `look for ${id}`,
});

describe("evalsFromDefs", () => {
  it("seeds fresh definitions with idle runtime state", () => {
    const out = evalsFromDefs([def("a"), def("b")]);
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.status).toBe("idle");
      expect(e.result).toBeUndefined();
      expect(e.lastRunAt).toBeUndefined();
    }
  });

  it("preserves prior runtime state (status/result/lastRunAt) by id", () => {
    const prev: Evaluation[] = [
      {
        ...def("a"),
        status: "flag",
        lastRunAt: 123,
        result: { flagged: true, severity: "warn", summary: "hit", evidence: [] },
      },
    ];
    const out = evalsFromDefs([def("a", "Renamed A"), def("b")], prev);

    const a = out.find((e) => e.id === "a")!;
    // content comes from the new def (e.g. a rename), state carries over
    expect(a.name).toBe("Renamed A");
    expect(a.status).toBe("flag");
    expect(a.lastRunAt).toBe(123);
    expect(a.result?.summary).toBe("hit");

    // a brand-new def starts idle
    const b = out.find((e) => e.id === "b")!;
    expect(b.status).toBe("idle");
    expect(b.result).toBeUndefined();
  });

  it("drops runtime state for defs removed from the new set", () => {
    const prev: Evaluation[] = [{ ...def("gone"), status: "ok" }];
    const out = evalsFromDefs([def("a")], prev);
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });
});

// The built-in library is now one template per MeetingKind: picking a kind must
// always find watchers to switch to, or applyKindTemplate silently no-ops and
// the lens and the watcher list drift apart.
describe("built-in templates", () => {
  const t = ((key: string) => key) as Parameters<typeof buildPresetEvalTemplates>[0];

  it("ships exactly one template per meeting kind", () => {
    const ids = buildPresetEvalTemplates(t).map((tpl) => tpl.id);
    expect(ids).toHaveLength(MEETING_KINDS.length);
    for (const kind of MEETING_KINDS) expect(ids).toContain(EVAL_TEMPLATE_OF[kind]);
  });

  it("gives every built-in evaluation a unique id and a real prompt", () => {
    for (const tpl of buildPresetEvalTemplates(t)) {
      const ids = tpl.evals.map((e) => e.id);
      expect(new Set(ids).size, `${tpl.id} has duplicate eval ids`).toBe(ids.length);
      for (const e of tpl.evals) expect(e.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  // A fresh install must look like a recognised template, otherwise the very
  // first auto-detected kind reads the untouched default as "hand-edited" and
  // refuses to switch the watchers.
  it("starts on the internal template, verbatim", () => {
    const templates = buildPresetEvalTemplates(t);
    const active = findActiveTemplate(templates, defaultEvalDefs(t));
    expect(active?.id).toBe(EVAL_TEMPLATE_OF.internal);
  });
});
