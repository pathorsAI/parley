import { describe, it, expect } from "vitest";

import { stageFor } from "./currentStage";
import type { Scenario } from "./bundles";

/** Minimal scenario stand-in — stageFor only reads id + order. */
function scenario(id: string, order: string[]): Scenario {
  return {
    id,
    name: id,
    icon: "",
    builtin: true,
    hasBoard: order.length > 0,
    guidance: "",
    order,
    names: {},
    bundles: {},
  };
}

const sales = scenario("sales", ["prospecting", "discovery", "demo", "negotiation", "closing"]);
const negotiation = scenario("negotiation", ["negotiation.main"]);

describe("stageFor", () => {
  it("takes the user's per-call choice", () => {
    expect(stageFor(sales, "demo")).toBe("demo");
  });

  it("falls back to the first stage with no choice", () => {
    expect(stageFor(sales, null)).toBe("prospecting");
  });

  it("ignores a per-call stage that isn't in this scenario", () => {
    // Switching scenarios leaves the old stage id behind; it must not stick.
    expect(stageFor(negotiation, "demo")).toBe("negotiation.main");
  });

  it("returns an empty stage for a boardless kind", () => {
    expect(stageFor(scenario("retro", []), null)).toBe("");
  });
});
