import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn() }));
vi.mock("../ai/provider", () => ({ JSON_MODE_INSTRUCTION: "" }));
const generateMock = vi.fn();
vi.mock("../ai/generate", () => ({
  generateObjectResilient: (...args: unknown[]) => generateMock(...args),
}));

import { backfillSlotIds, eligibleForBackfill, slotNoneSentinel } from "./backfill";
import type { StageBundle } from "./bundles";
import type { Claim } from "./types";
import type { Settings } from "../types";

const settings = { language: "zh-TW" } as unknown as Settings;

const bundle: StageBundle = {
  stage: "discovery",
  boardTitle: "SPIN",
  slots: [
    { id: "discovery.problem", label: "P", hint: "pains", query: { categories: ["risk"], side: "theirs" } },
    { id: "discovery.committee", label: "委", hint: "who signs", query: { categories: ["stance"] } },
  ],
  exitCriteria: [],
  coachRules: [],
};

let seq = 0;
function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: `c${seq++}`,
    companyId: "co",
    subjects: [],
    category: "risk",
    side: "theirs",
    text: "x",
    provenance: [{ kind: "user" }],
    confidence: "inferred",
    status: "active",
    createdAt: 0,
    lastSupportedAt: 0,
    ...over,
  };
}

describe("eligibleForBackfill", () => {
  it("keeps query-hit cards not yet classified for this stage; drops the rest", () => {
    const fresh = claim(); // query-hit, never classified → in
    const otherStage = claim({ slotIds: ["prospecting.pain"] }); // tagged elsewhere → in
    const tagged = claim({ slotIds: ["discovery.problem"] }); // already this stage → out
    const none = claim({ slotIds: [slotNoneSentinel("discovery")] }); // classified-none → out
    const miss = claim({ category: "leverage" }); // no slot query hits → out
    const dead = claim({ status: "wrong" }); // inactive → out
    expect(eligibleForBackfill([fresh, otherStage, tagged, none, miss, dead], bundle)).toEqual([
      fresh,
      otherStage,
    ]);
  });
});

describe("backfillSlotIds", () => {
  beforeEach(() => generateMock.mockClear());

  it("returns [] without an LLM call when nothing is eligible", async () => {
    const out = await backfillSlotIds({ settings, bundle, claims: [claim({ category: "leverage" })] });
    expect(out).toEqual([]);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("whitelists returned slot ids, sentinels the unmentioned, merges other-stage ids", async () => {
    const assigned = claim();
    const unmentioned = claim({ slotIds: ["prospecting.pain"] });
    generateMock.mockResolvedValueOnce({
      object: {
        assignments: [{ claimId: assigned.id, slotIds: ["discovery.problem", "bogus.slot"] }],
      },
      usage: {},
    });
    const out = await backfillSlotIds({ settings, bundle, claims: [assigned, unmentioned] });
    expect(out).toEqual([
      { claimId: assigned.id, slotIds: ["discovery.problem"] },
      { claimId: unmentioned.id, slotIds: ["prospecting.pain", "discovery.none"] },
    ]);
  });

  it("dedupes concurrent identical runs into one LLM call", async () => {
    const c = claim();
    let release!: (v: unknown) => void;
    generateMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    const p1 = backfillSlotIds({ settings, bundle, claims: [c] });
    const p2 = backfillSlotIds({ settings, bundle, claims: [c] });
    release({ object: { assignments: [{ claimId: c.id, slotIds: ["discovery.problem"] }] }, usage: {} });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });
});
