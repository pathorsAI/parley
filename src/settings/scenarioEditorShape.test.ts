import { describe, it, expect } from "vitest";

import { initialStageId, scenarioEditorShape, stageAfterRemoval } from "./scenarioEditorShape";

describe("scenarioEditorShape", () => {
  it("calls a stageless scenario a kind", () => {
    expect(scenarioEditorShape([])).toBe("kind");
  });

  it("calls one stage single — no chips, no second click", () => {
    expect(scenarioEditorShape(["negotiation"])).toBe("single");
  });

  it("calls two or more stages multi", () => {
    expect(scenarioEditorShape(["discovery", "demo"])).toBe("multi");
    expect(scenarioEditorShape(["a", "b", "c", "d", "e"])).toBe("multi");
  });
});

describe("initialStageId", () => {
  it("picks the first stage", () => {
    expect(initialStageId(["discovery", "demo"])).toBe("discovery");
  });

  it("has nothing to pick for a kind", () => {
    expect(initialStageId([])).toBeNull();
  });
});

describe("stageAfterRemoval", () => {
  it("falls back to the first survivor", () => {
    expect(stageAfterRemoval(["a", "b", "c"], "b")).toBe("a");
    expect(stageAfterRemoval(["a", "b", "c"], "a")).toBe("b");
  });

  it("returns null when the last stage goes", () => {
    expect(stageAfterRemoval(["a"], "a")).toBeNull();
  });

  it("leaves the selection alone when the removed id is not in the list", () => {
    expect(stageAfterRemoval(["a", "b"], "ghost")).toBe("a");
  });
});
