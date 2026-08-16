import { describe, expect, it, vi } from "vitest";

// resolveBoard reads the live store/stage file — not under test here (the pure
// helpers are); stub the chain so importing boards.ts is clean.
vi.mock("../scenarios/currentStage", () => ({ resolveScenarioStageId: vi.fn() }));

import { translate, type TranslationKey } from "../../i18n/messages";
import {
  applyNextStepGate,
  boardFromBundle,
  nextSlotIdOf,
  slotStateOf,
  withSharedSlots,
  type MeetingBoard,
} from "./boards";
import { buildScenarioSet } from "../scenarios/bundles";
import { EMPTY_BUNDLE_FILE, type SlotDef } from "../scenarios/bundleFile";
import type { IntelSlotFill } from "../types";

const t = (key: TranslationKey) => translate("zh-TW", key);
const tr = (k: string) => t(k as TranslationKey);

function slot(id: string, solidAt?: number): SlotDef {
  return { id, label: id, hint: "h", ...(solidAt ? { solidAt } : {}) };
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
    // Non-sales boards get the next slot only.
    expect(withSharedSlots([slot("iv.depth")], t).map((s) => s.id)).toEqual([
      "iv.depth",
      "sales.next",
    ]);
  });

  it("keeps the bundle's own next-step and competitor slots", () => {
    const own = [slot("prospecting.next"), slot("prospecting.competitors")];
    const out = withSharedSlots(own, t, { competitors: true });
    expect(out).toHaveLength(2);
    expect(nextSlotIdOf(out)).toBe("prospecting.next");
  });
});

describe("slotStateOf", () => {
  it("reads a slot's coverage off this call's fills", () => {
    expect(slotStateOf(slot("a"), 0)).toBe("empty");
    expect(slotStateOf(slot("a"), 1)).toBe("thin");
    expect(slotStateOf(slot("a"), 2)).toBe("solid");
  });

  it("honours a slot's own threshold", () => {
    expect(slotStateOf(slot("a", 1), 1)).toBe("solid");
    expect(slotStateOf(slot("a", 3), 2)).toBe("thin");
  });
});

describe("buildScenarioSet (builtins)", () => {
  const set = buildScenarioSet(tr, EMPTY_BUNDLE_FILE);

  it("ships sales (multi-stage) + negotiation/partnership (single-stage), then the boardless kinds", () => {
    expect(set.list.map((s) => s.id)).toEqual([
      "sales",
      "negotiation",
      "partnership",
      "retro",
      "officehour",
    ]);
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
