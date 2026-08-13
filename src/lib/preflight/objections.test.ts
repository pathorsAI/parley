import { describe, expect, it } from "vitest";
import { splitObjection } from "./objections";

describe("splitObjection", () => {
  it("splits on the full-width arrow the prompt asks for", () => {
    expect(splitObjection("他們說預算今年凍結 → 問明年度規劃什麼時候拍板")).toEqual({
      trigger: "他們說預算今年凍結",
      move: "問明年度規劃什麼時候拍板",
    });
  });

  it("also accepts an ASCII arrow", () => {
    expect(splitObjection("Budget is frozen -> ask when next year's cycle opens")).toEqual({
      trigger: "Budget is frozen",
      move: "ask when next year's cycle opens",
    });
  });

  it("keeps a line with no arrow as a pushback with no scripted answer", () => {
    expect(splitObjection("  他們會嫌太貴  ")).toEqual({ trigger: "他們會嫌太貴", move: "" });
  });

  it("splits on the FIRST arrow so a counter containing one survives", () => {
    expect(splitObjection("嫌貴 → 用 A → B 的節省來換算")).toEqual({
      trigger: "嫌貴",
      move: "用 A → B 的節省來換算",
    });
  });
});
