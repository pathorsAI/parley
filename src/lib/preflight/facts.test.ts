import { describe, expect, it } from "vitest";
import { collectPrepFacts, factsDigest, prepHeadline } from "./facts";
import type { SlotDef } from "../scenarios/bundleFile";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function slot(id: string, label: string, hint = ""): SlotDef {
  return { id, label, hint };
}

const EMPTY_PREP = { target: "", batna: "", floor: "", context: "", agenda: [] as string[] };

function build(over: Partial<Parameters<typeof collectPrepFacts>[0]> = {}) {
  return collectPrepFacts({
    folder: "和運租車",
    scenarioName: "銷售",
    stageLabel: "議價",
    exitCriteria: [],
    slots: [],
    meetings: [],
    prep: EMPTY_PREP,
    ...over,
  });
}

describe("collectPrepFacts", () => {
  it("sorts meetings newest first", () => {
    const facts = build({
      meetings: [
        { title: "第一次", createdAt: NOW - 30 * DAY },
        { title: "報價討論", createdAt: NOW - DAY },
      ],
    });
    expect(facts.meetings.map((m) => m.title)).toEqual(["報價討論", "第一次"]);
  });

  it("reduces the board to what each slot wants", () => {
    const facts = build({ slots: [slot("neg.authority", "決策鏈", "誰能簽")] });
    expect(facts.board).toEqual([{ label: "決策鏈", hint: "誰能簽" }]);
  });
});

describe("prepHeadline", () => {
  it("counts the upcoming call as the next one", () => {
    const facts = build({ meetings: [{ title: "報價討論", createdAt: NOW }] });
    const head = prepHeadline(facts);
    expect(head.nth).toBe(2);
    expect(head.lastMeeting?.title).toBe("報價討論");
  });

  it("is the first call when there is no history", () => {
    expect(prepHeadline(build()).nth).toBe(1);
  });
});

describe("factsDigest", () => {
  it("names the customer, the stage and the board", () => {
    const digest = factsDigest(
      build({
        slots: [slot("a", "預算", "多少錢、誰的預算")],
        exitCriteria: ["報價已送出"],
        meetings: [{ title: "第一次", createdAt: NOW - DAY }],
      })
    );
    expect(digest).toContain("和運租車");
    expect(digest).toContain("Stage: 議價");
    expect(digest).toContain("預算: 多少錢、誰的預算");
    expect(digest).toContain("報價已送出");
    expect(digest).toContain("conversation #2");
  });

  it("says outright when the negotiation setup is still blank", () => {
    const digest = factsDigest(build());
    expect(digest).toContain("My BATNA: (not set yet)");
    expect(digest).toContain("My bottom line: (not set yet)");
  });
});
