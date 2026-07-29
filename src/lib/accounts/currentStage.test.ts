import { describe, it, expect } from "vitest";

import { stageFor } from "./currentStage";
import type { Scenario } from "./bundles";
import type { Thread } from "./types";

/** Minimal scenario stand-in — stageFor only reads id + order. */
function scenario(id: string, order: string[]): Scenario {
  return {
    id,
    name: id,
    icon: "",
    builtin: true,
    guidance: "",
    order,
    names: {},
    bundles: {},
  };
}

const sales = scenario("sales", ["prospecting", "discovery", "demo", "negotiation", "closing"]);
const negotiation = scenario("negotiation", ["negotiation.main"]);

function thread(patch: Partial<Pick<Thread, "kind" | "stage">>): Pick<Thread, "kind" | "stage"> {
  return { kind: "sales", ...patch };
}

describe("stageFor", () => {
  it("prefers the user's per-call choice over everything else", () => {
    expect(stageFor(sales, "demo", thread({ stage: "closing" }))).toBe("demo");
  });

  it("falls back to the linked sales thread's stage", () => {
    expect(stageFor(sales, null, thread({ stage: "negotiation" }))).toBe("negotiation");
  });

  it("falls back to the first stage with no choice and no thread", () => {
    expect(stageFor(sales, null, null)).toBe("prospecting");
  });

  it("ignores a per-call stage that isn't in this scenario", () => {
    // Switching scenarios leaves the old stage id behind; it must not stick.
    expect(stageFor(negotiation, "demo", null)).toBe("negotiation.main");
  });

  it("ignores a thread stage that isn't in this scenario", () => {
    expect(stageFor(sales, null, thread({ stage: "made-up" }))).toBe("prospecting");
  });

  it("only inherits a thread stage for the sales scenario", () => {
    const custom = scenario("custom", ["a", "b"]);
    expect(stageFor(custom, null, thread({ stage: "b" }))).toBe("a");
  });

  it("ignores a non-sales thread's stage", () => {
    expect(stageFor(sales, null, { kind: "investment", stage: "closing" })).toBe("prospecting");
  });
});
