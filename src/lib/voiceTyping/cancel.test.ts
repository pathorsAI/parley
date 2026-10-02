import { describe, expect, it } from "vitest";
import { CancelLedger } from "./cancel";

describe("CancelLedger", () => {
  it("holds a cancelled dictation's settled text instead of delivering it", () => {
    const l = new CancelLedger();
    expect(l.cancel(1)).toBe(true);
    expect(l.settle(1, "取消的話", false)).toBe("hold");
    expect(l.isCancelled(1)).toBe(true);
  });

  it("recovers the moment it settles when Undo came first", () => {
    const l = new CancelLedger();
    l.cancel(1);
    expect(l.undo()).toEqual({ kind: "wait", gen: 1 });
    expect(l.settle(1, "還沒好", false)).toBe("recover");
  });

  it("hands back settled text once, then has nothing more to undo", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.settle(1, "好了", true);
    expect(l.undo()).toEqual({ kind: "now", gen: 1, text: "好了", polished: true });
    expect(l.undo()).toEqual({ kind: "none" });
  });

  it("drops it when the offer runs out, and a late settle still never delivers", () => {
    const l = new CancelLedger();
    l.cancel(1);
    expect(l.expire()).toBe(1);
    expect(l.isCancelled(1)).toBe(true);
    expect(l.undo()).toEqual({ kind: "none" });
    expect(l.settle(1, "太晚了", false)).toBe("discard");
  });

  it("drops an un-recovered cancel on a new press, which still never delivers", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.settle(1, "舊的", false);
    expect(l.supersede()).toBe(true);
    expect(l.isCancelled(1)).toBe(true);
    expect(l.undo()).toEqual({ kind: "none" });
  });

  it("keeps an Undo already asked through a new press and the offer running out", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.undo();
    expect(l.supersede()).toBe(false);
    expect(l.expire()).toBeNull();
    expect(l.settle(1, "要回來", false)).toBe("recover");
  });

  it("keeps an Undo already asked when a later dictation is cancelled too", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.undo();
    l.cancel(2);
    expect(l.settle(1, "第一句", false)).toBe("recover");
    expect(l.settle(2, "第二句", false)).toBe("hold");
  });

  it("a later cancel replaces the earlier offer", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.cancel(2);
    expect(l.settle(1, "第一句", false)).toBe("discard");
    expect(l.settle(2, "第二句", false)).toBe("hold");
  });

  it("a second Escape on the same dictation is a no-op", () => {
    const l = new CancelLedger();
    expect(l.cancel(1)).toBe(true);
    expect(l.cancel(1)).toBe(false);
  });

  it("forgets a dictation whose start failed", () => {
    const l = new CancelLedger();
    l.cancel(1);
    l.forget(1);
    expect(l.isCancelled(1)).toBe(false);
    expect(l.undo()).toEqual({ kind: "none" });
    expect(l.expire()).toBeNull();
  });

  it("an uncancelled dictation is not cancelled, and has nothing to settle", () => {
    const l = new CancelLedger();
    expect(l.isCancelled(2)).toBe(false);
    expect(l.settle(2, "照常", false)).toBe("discard");
    expect(l.expire()).toBeNull();
    expect(l.supersede()).toBe(false);
  });

  it("only remembers the most recent cancels", () => {
    const l = new CancelLedger();
    for (let g = 1; g <= 20; g++) l.cancel(g);
    expect(l.isCancelled(1)).toBe(false);
    expect(l.isCancelled(20)).toBe(true);
  });
});
