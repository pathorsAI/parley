import { describe, expect, it } from "vitest";
import { actionItemsCopyText, actionItemsPageText, distinctOwners, groupActionItemsBySide } from "./actionItemSides";
import type { ActionItem } from "../types";

const item = (id: string, over: Partial<ActionItem> = {}): ActionItem => ({
  id,
  text: `do ${id}`,
  done: false,
  linkedEventId: null,
  atMs: null,
  ...over,
});

describe("groupActionItemsBySide", () => {
  it("is null when no item has a side, so old recordings keep the flat list", () => {
    expect(groupActionItemsBySide([item("a"), item("b")])).toBeNull();
    expect(groupActionItemsBySide([])).toBeNull();
  });

  it("puts us first then them, keeping each side's order", () => {
    const groups = groupActionItemsBySide([
      item("t1", { side: "them" }),
      item("u1", { side: "us" }),
      item("t2", { side: "them" }),
      item("u2", { side: "us" }),
    ]);
    expect(groups?.map((g) => [g.side, g.items.map((a) => a.id)])).toEqual([
      ["us", ["u1", "u2"]],
      ["them", ["t1", "t2"]],
    ]);
  });

  it("files a side-less item in a sided list with us, and drops an empty side", () => {
    const groups = groupActionItemsBySide([item("u1", { side: "us" }), item("x")]);
    expect(groups).toEqual([{ side: "us", items: [item("u1", { side: "us" }), item("x")] }]);
    expect(groupActionItemsBySide([item("t", { side: "them" })])?.map((g) => g.side)).toEqual(["them"]);
  });
});

describe("distinctOwners", () => {
  it("lists each owner once, in first-seen order, skipping blanks", () => {
    expect(
      distinctOwners([
        item("a", { owner: "Kevin" }),
        item("b"),
        item("c", { owner: " " }),
        item("d", { owner: "Amy" }),
        item("e", { owner: "Kevin " }),
      ])
    ).toEqual(["Kevin", "Amy"]);
  });
});

describe("actionItemsCopyText", () => {
  const zhOwner = (o: string) => `（${o}）`;

  it("numbers the items under the header, with the owner when known", () => {
    const text = actionItemsCopyText(
      "派斯科技 後續要做：",
      [item("a", { text: "寄報價單", owner: "Kevin" }), item("b", { text: "安排 demo " })],
      zhOwner
    );
    expect(text).toBe("派斯科技 後續要做：\n1. 寄報價單（Kevin）\n2. 安排 demo");
  });

  it("uses the given owner format (en)", () => {
    expect(
      actionItemsCopyText("Us next steps:", [item("a", { text: "Send it", owner: "Amy" })], (o) => ` (${o})`)
    ).toBe("Us next steps:\n1. Send it (Amy)");
  });
});

describe("actionItemsPageText", () => {
  const header = (side: "us" | "them") => (side === "us" ? "We do:" : "They do:");
  const owner = (o: string) => ` (${o})`;

  it("lists each side under its header, with owners and no timestamps or done marks", () => {
    const items = [
      item("a", { side: "us", owner: "Kevin", atMs: 125_000, done: true }),
      item("b", { side: "them", atMs: 60_000 }),
      item("c", { side: "us" }),
    ];
    expect(actionItemsPageText(items, header, owner)).toBe("We do:\n1. do a (Kevin)\n2. do c\n\nThey do:\n1. do b");
  });

  it("is one numbered list when no item has a side", () => {
    expect(actionItemsPageText([item("a", { atMs: 5_000 }), item("b")], header, owner)).toBe("1. do a\n2. do b");
  });

  it("is empty with no items", () => {
    expect(actionItemsPageText([], header, owner)).toBe("");
  });
});
