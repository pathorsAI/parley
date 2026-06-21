import { describe, it, expect } from "vitest";
import { evalsFromDefs } from "./presets";
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
