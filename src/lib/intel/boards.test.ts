import { describe, expect, it, vi } from "vitest";

// resolveBoard reads the live store/stage file — not under test here (the pure
// helpers are); stub the chain so importing boards.ts is clean.
vi.mock("../accounts/currentStage", () => ({ resolveScenarioStageId: vi.fn() }));

import { translate, type TranslationKey } from "../../i18n/messages";
import {
  applyNextStepGate,
  boardFromBundle,
  fillsToClaimCandidates,
  nextSlotIdOf,
  withSharedSlots,
  type MeetingBoard,
} from "./boards";
import { buildScenarioSet } from "../accounts/bundles";
import { EMPTY_BUNDLE_FILE, type SlotDef } from "../accounts/bundleFile";
import type { IntelSlotFill } from "../types";

const t = (key: TranslationKey) => translate("zh-TW", key);
const tr = (k: string) => t(k as TranslationKey);

function slot(id: string, query: SlotDef["query"] = { categories: [] }): SlotDef {
  return { id, label: id, hint: "h", query };
}

function fill(slotId: string, text: string, speaker: "me" | "them" = "them"): IntelSlotFill {
  return { slotId, text, quote: "", speaker };
}

describe("withSharedSlots", () => {
  it("appends next-step (always) and competitors (sales) when the bundle lacks them", () => {
    const out = withSharedSlots([slot("discovery.problem")], t, { competitors: true });
    expect(out.map((s) => s.id)).toEqual([
      "discovery.problem",
      "sales.next",
      "sales.competitors",
    ]);
    expect(out[1].query.categories).toEqual(["nextmove"]);
    // Non-sales boards get the next slot only.
    expect(withSharedSlots([slot("iv.depth")], t).map((s) => s.id)).toEqual([
      "iv.depth",
      "sales.next",
    ]);
  });

  it("keeps the bundle's own .next slot (prospecting) and competitor query", () => {
    const own = [
      slot("prospecting.next", { categories: ["nextmove"] }),
      slot("prospecting.rivals", { categories: ["competitor"] }),
    ];
    const out = withSharedSlots(own, t, { competitors: true });
    expect(out).toHaveLength(2);
    expect(nextSlotIdOf(out)).toBe("prospecting.next");
  });
});

describe("buildScenarioSet (builtins)", () => {
  const set = buildScenarioSet(tr, EMPTY_BUNDLE_FILE);

  it("ships sales (multi-stage) + negotiation/partnership (single-stage)", () => {
    expect(set.list.map((s) => s.id)).toEqual(["sales", "negotiation", "partnership"]);
    expect(set.byId.sales.order.length).toBeGreaterThan(1);
    expect(set.byId.negotiation.order).toEqual(["nego"]);
    expect(set.byId.partnership.order).toEqual(["partner"]);
  });

  it("typed boards carry i18n labels and a next-step slot; boardFromBundle gates them", () => {
    const nego = set.byId.negotiation;
    const bundle = nego.bundles.nego;
    expect(bundle.slots.map((s) => s.id)).toEqual([
      "nego.numbers",
      "nego.give",
      "nego.get",
      "nego.agreed",
      "nego.open",
      "nego.next",
    ]);
    expect(bundle.slots[0].label).toBe("數字帳本");
    const board = boardFromBundle(nego, bundle, t);
    expect(board.nextSlotId).toBe("nego.next");
    expect(board.durationMin).toBe(60);
    expect(board.gateAtRemainingPct).toBe(20);
    // No competitor slot outside sales.
    expect(board.slots.some((s) => s.id === "sales.competitors")).toBe(false);
  });

  it("every sales stage board ends with a next-step slot (own or shared)", () => {
    const sales = set.byId.sales;
    for (const stage of sales.order) {
      const board = boardFromBundle(sales, sales.bundles[stage], t);
      expect(board.nextSlotId, stage).not.toBeNull();
    }
  });
});

describe("applyNextStepGate", () => {
  const board: MeetingBoard = {
    scenarioId: "negotiation",
    stageId: "nego",
    guidance: "",
    slots: [slot("nego.numbers"), slot("nego.next")],
    durationMin: 60,
    gateAtRemainingPct: 20,
    nextSlotId: "nego.next",
  };
  const gate = { question: "釘下一步", reason: "快結束了" };
  const MIN = 60_000;

  it("passes the focus through before the gate point", () => {
    const focus = { kind: "gap" as const, slotId: "nego.numbers", question: "q", reason: "r" };
    expect(
      applyNextStepGate({ focus, fills: [], board, elapsedMs: 30 * MIN, ...gate })
    ).toBe(focus);
  });

  it("overrides a gap focus once the last stretch starts and next is empty", () => {
    const focus = { kind: "gap" as const, slotId: "nego.numbers", question: "q", reason: "r" };
    const out = applyNextStepGate({ focus, fills: [], board, elapsedMs: 49 * MIN, ...gate });
    expect(out).toEqual({ kind: "gap", slotId: "nego.next", question: "釘下一步", reason: "快結束了" });
  });

  it("an objection focus outranks the gate; a filled next slot disarms it", () => {
    const objection = { kind: "objection" as const, slotId: "", question: "counter", reason: "r" };
    expect(
      applyNextStepGate({ focus: objection, fills: [], board, elapsedMs: 59 * MIN, ...gate })
    ).toBe(objection);
    expect(
      applyNextStepGate({
        focus: undefined,
        fills: [fill("nego.next", "下週三 demo")],
        board,
        elapsedMs: 59 * MIN,
        ...gate,
      })
    ).toBeUndefined();
  });
});

describe("fillsToClaimCandidates", () => {
  const slots = [
    slot("discovery.problem", { categories: ["risk", "stance"], side: "theirs" }),
    slot("sales.next", { categories: ["nextmove"] }),
  ];

  it("maps fills to claims riding the slot's query, deduped, unknown slots dropped", () => {
    const out = fillsToClaimCandidates(
      [
        fill("discovery.problem", "旺季每天五六次改單"),
        fill("discovery.problem", "旺季每天五六次改單"), // dupe
        fill("sales.next", "下週提供欄位清單"),
        fill("ghost.slot", "orphan"),
      ],
      slots
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      category: "risk",
      side: "theirs",
      slotIds: ["discovery.problem"],
      text: "旺季每天五六次改單",
    });
    expect(out[1]).toMatchObject({ category: "nextmove", slotIds: ["sales.next"] });
  });
});
