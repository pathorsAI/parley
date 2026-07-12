import { describe, expect, it } from "vitest";
import {
  boardStates,
  claimsForSlot,
  SLOT_SOLID_AT,
  SLOT_STALE_DAYS,
  slotQueryMatches,
  slotState,
} from "./slotState";
import type { SlotDef, StageBundle } from "./bundles";
import type { Claim } from "./types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed clock — the functions are pure

function slot(over: Partial<SlotDef> = {}): SlotDef {
  return {
    id: "discovery.problem",
    label: "P",
    hint: "pains in their words",
    query: { categories: ["risk"], side: "theirs" },
    ...over,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: crypto.randomUUID(),
    companyId: "co",
    subjects: [],
    category: "risk",
    side: "theirs",
    text: "x",
    provenance: [{ kind: "user" }],
    confidence: "inferred",
    status: "active",
    createdAt: NOW,
    lastSupportedAt: NOW,
    ...over,
  };
}

describe("slotQueryMatches", () => {
  it("matches on category and honors side/layer constraints", () => {
    expect(slotQueryMatches(claim(), slot())).toBe(true);
    expect(slotQueryMatches(claim({ category: "goal" }), slot())).toBe(false);
    expect(slotQueryMatches(claim({ side: "ours" }), slot())).toBe(false);
    // Unconstrained side/layer accept anything.
    expect(slotQueryMatches(claim({ side: undefined }), slot({ query: { categories: ["risk"] } }))).toBe(true);
    expect(
      slotQueryMatches(claim({ layer: "surface" }), slot({ query: { categories: ["risk"], layer: "deep" } }))
    ).toBe(false);
  });

  it("empty category list (coarse-converted stages) matches nothing", () => {
    expect(slotQueryMatches(claim(), slot({ query: { categories: [] } }))).toBe(false);
  });
});

describe("claimsForSlot", () => {
  it("tagged cards are authoritative — [] means classified-none even when the query matches", () => {
    const tagged = claim({ slotIds: ["discovery.problem"], category: "goal" }); // query would MISS
    const none = claim({ slotIds: [] }); // query would HIT
    const untagged = claim(); // query hits → coarse fallback
    const out = claimsForSlot([tagged, none, untagged], slot());
    expect(out).toHaveLength(2);
    expect(out).toContain(tagged);
    expect(out).toContain(untagged);
  });

  it("excludes non-active claims regardless of tagging", () => {
    const wrong = claim({ slotIds: ["discovery.problem"], status: "wrong" });
    const superseded = claim({ status: "superseded" });
    expect(claimsForSlot([wrong, superseded], slot())).toHaveLength(0);
  });
});

describe("slotState — 空/薄/實 boundaries", () => {
  it("empty at zero cards", () => {
    expect(slotState([], slot(), NOW)).toBe("empty");
  });

  it("one fresh inferred card = thin; solidAt fresh cards = solid", () => {
    expect(slotState([claim()], slot(), NOW)).toBe("thin");
    const two = [claim(), claim()];
    expect(two).toHaveLength(SLOT_SOLID_AT); // guard: the default really is 2
    expect(slotState(two, slot(), NOW)).toBe("solid");
  });

  it("a single fresh CONFIRMED card is solid on its own", () => {
    expect(slotState([claim({ confidence: "confirmed" })], slot(), NOW)).toBe("solid");
  });

  it("stale cards never make solid — even confirmed, even many", () => {
    const stale = NOW - (SLOT_STALE_DAYS * DAY + 1);
    const cards = [
      claim({ confidence: "confirmed", lastSupportedAt: stale }),
      claim({ lastSupportedAt: stale }),
      claim({ lastSupportedAt: stale }),
    ];
    expect(slotState(cards, slot(), NOW)).toBe("thin");
  });

  it("exactly-30-days-old still counts as fresh (boundary is inclusive)", () => {
    const edge = NOW - SLOT_STALE_DAYS * DAY;
    expect(slotState([claim({ confidence: "confirmed", lastSupportedAt: edge })], slot(), NOW)).toBe(
      "solid"
    );
  });

  it("slot-level solidAt override wins (prospecting.next uses 1)", () => {
    expect(slotState([claim()], slot({ solidAt: 1 }), NOW)).toBe("solid");
  });
});

describe("boardStates", () => {
  it("returns one entry per bundle slot, wired through attach + state", () => {
    const bundle: StageBundle = {
      stage: "discovery",
      boardTitle: "b",
      slots: [
        slot(),
        slot({ id: "discovery.committee", query: { categories: ["stance"] } }),
      ],
      exitCriteria: ["x"],
      coachRules: [],
    };
    const cards = [claim({ confidence: "confirmed" })];
    const board = boardStates(cards, bundle, NOW);
    expect(board.map((b) => [b.slot.id, b.state])).toEqual([
      ["discovery.problem", "solid"],
      ["discovery.committee", "empty"],
    ]);
    expect(board[0].claims).toHaveLength(1);
  });
});
