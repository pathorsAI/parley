import { describe, expect, it } from "vitest";
import { collectPrepFacts, factsDigest, prepHeadline } from "./facts";
import type { SlotDef } from "../accounts/bundleFile";
import type { SlotState } from "../accounts/slotState";
import type { Claim, Company, Person, Thread } from "../accounts/types";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function company(over: Partial<Company> = {}): Company {
  return { id: "co", name: "和運租車", aliases: [], note: "車隊 3000 台", createdAt: NOW, archived: false, ...over };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: crypto.randomUUID(),
    companyId: "co",
    subjects: [],
    category: "risk",
    text: "x",
    provenance: [{ kind: "user" }],
    confidence: "inferred",
    status: "active",
    createdAt: NOW,
    lastSupportedAt: NOW,
    ...over,
  };
}

function slot(id: string, label: string): SlotDef {
  return { id, label, hint: "", query: { categories: ["risk"] } };
}

function row(id: string, label: string, state: SlotState, claims: Claim[] = []) {
  return { slot: slot(id, label), claims, state };
}

const EMPTY_PREP = { target: "", batna: "", floor: "", context: "", agenda: [] as string[] };

function build(over: Partial<Parameters<typeof collectPrepFacts>[0]> = {}) {
  return collectPrepFacts({
    company: company(),
    thread: null,
    attendees: [],
    claims: [],
    boardRows: [],
    stageLabel: "議價",
    meetings: [],
    prep: EMPTY_PREP,
    roleLabel: (r) => r,
    ...over,
  });
}

describe("collectPrepFacts", () => {
  it("keeps only the freshest claims per category", () => {
    const facts = build({
      claims: [
        claim({ category: "redline", text: "舊紅線", lastSupportedAt: NOW - 10 * DAY }),
        claim({ category: "redline", text: "新紅線", lastSupportedAt: NOW }),
        claim({ category: "openq", text: "預算歸誰核？" }),
      ],
    });
    expect(facts.redlines).toEqual(["新紅線", "舊紅線"]);
    expect(facts.openQuestions).toEqual(["預算歸誰核？"]);
  });

  it("splits leverage by side", () => {
    const facts = build({
      claims: [
        claim({ category: "leverage", side: "ours", text: "可綁三年約" }),
        claim({ category: "leverage", side: "theirs", text: "他們有第二家在報" }),
      ],
    });
    expect(facts.leverageOurs).toEqual(["可綁三年約"]);
    expect(facts.leverageTheirs).toEqual(["他們有第二家在報"]);
  });

  it("carries the freshest card into each gap", () => {
    const cards = [
      claim({ text: "林協理可核 300 萬", lastSupportedAt: NOW }),
      claim({ text: "舊的說法", lastSupportedAt: NOW - DAY }),
    ];
    const facts = build({ boardRows: [row("neg.authority", "決策鏈", "thin", cards)] });
    expect(facts.gaps[0]).toMatchObject({ label: "決策鏈", state: "thin", top: "林協理可核 300 萬" });
  });

  it("sorts meetings newest first", () => {
    const facts = build({
      meetings: [
        { title: "第一次", createdAt: NOW - 30 * DAY },
        { title: "報價討論", createdAt: NOW - DAY },
      ],
    });
    expect(facts.meetings.map((m) => m.title)).toEqual(["報價討論", "第一次"]);
  });

  it("labels committee roles through the caller's translator", () => {
    const person: Person = {
      id: "p1",
      companyId: "co",
      name: "林協理",
      aliases: [],
      title: "採購",
      committeeRole: "economic",
      influencedBy: [],
      createdAt: NOW,
      archived: false,
    };
    const facts = build({ attendees: [person], roleLabel: () => "經濟決策者" });
    expect(facts.attendees[0]).toMatchObject({ name: "林協理", role: "經濟決策者" });
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

  it("separates empty gaps from thin ones", () => {
    const facts = build({
      boardRows: [
        row("a", "預算", "empty"),
        row("b", "決策鏈", "thin"),
        row("c", "痛點", "solid"),
      ],
    });
    const head = prepHeadline(facts);
    expect(head.emptyGaps).toEqual(["預算"]);
    expect(head.thinGaps).toEqual(["決策鏈"]);
  });
});

describe("factsDigest", () => {
  it("marks gap states and spells out red lines", () => {
    const digest = factsDigest(
      build({
        claims: [claim({ category: "redline", text: "不可透露現有報價結構" })],
        boardRows: [row("a", "預算", "empty"), row("b", "痛點", "solid", [claim({ text: "調度人力吃緊" })])],
        thread: { id: "t", companyId: "co", companyRoles: [], kind: "sales", name: "車隊語音客服", status: "active", committee: [], createdAt: NOW } as Thread,
      })
    );
    expect(digest).toContain("○ 預算: (nothing yet)");
    expect(digest).toContain("✔ 痛點: 調度人力吃緊");
    expect(digest).toContain("不可透露現有報價結構");
    expect(digest).toContain("車隊語音客服");
    expect(digest).toContain("conversation #1");
  });

  it("says outright when the negotiation setup is still blank", () => {
    const digest = factsDigest(build());
    expect(digest).toContain("My BATNA: (not set yet)");
    expect(digest).toContain("My bottom line: (not set yet)");
  });
});
