import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrepFacts } from "../preflight/facts";
import type { Settings } from "../types";

/**
 * The contract these lock down is the one the whole redesign rests on: the
 * copilot drafts the negotiation setup so the user doesn't have to invent it —
 * which is only safe as long as the copilot doesn't invent it either. A
 * fabricated BATNA flows straight into the live negotiation evaluations.
 */

const generateObjectResilient = vi.fn();

vi.mock("./generate", () => ({
  generateObjectResilient: (...args: unknown[]) => generateObjectResilient(...args),
}));
vi.mock("./provider", () => ({
  getModel: () => ({}),
  getProviderOptions: () => ({}),
  JSON_MODE_INSTRUCTION: "",
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn() }));
// The logger reaches for `window` to pick a Tauri vs browser sink; these tests
// run in node.
vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const settings = {
  language: "zh-TW",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
} as unknown as Settings;

const facts: PrepFacts = {
  company: { name: "和運租車", note: "" },
  thread: null,
  stageLabel: "議價",
  attendees: [],
  meetings: [],
  redlines: [],
  openQuestions: [],
  gaps: [],
  leverageOurs: [],
  leverageTheirs: [],
  risks: [],
  competitors: [],
  nextMoves: [],
  prep: { target: "", batna: "", floor: "", context: "", agenda: [] },
};

function resolveWith(object: unknown) {
  generateObjectResilient.mockResolvedValue({ object, usage: {} });
}

beforeEach(() => {
  generateObjectResilient.mockReset();
});

describe("draftPlan", () => {
  it("keeps an unknowable BATNA and bottom line blank", async () => {
    resolveWith({
      agenda: ["問出核決權限"],
      idealPath: [{ move: "對回上次報價", why: "延續上次的收尾" }],
      edgeCases: [{ trigger: "他先開口砍價", move: "不接數字，回問核決" }],
      target: "要到下次會期",
      batna: "",
      floor: "   ",
    });
    const { draftPlan } = await import("./prep");
    const plan = await draftPlan({ settings, facts, history: [] });
    expect(plan.batna).toBe("");
    expect(plan.floor).toBe("");
    expect(plan.target).toBe("要到下次會期");
  });

  it("drops blank agenda items and half-written steps", async () => {
    resolveWith({
      agenda: ["問出核決權限", "  ", ""],
      idealPath: [
        { move: "對回上次報價", why: "延續" },
        { move: "  ", why: "沒寫完" },
      ],
      edgeCases: [
        { trigger: "說要再研究", move: "直接約下次" },
        { trigger: "", move: "孤兒" },
        { trigger: "只有觸發", move: "" },
      ],
      target: "",
      batna: "",
      floor: "",
    });
    const { draftPlan } = await import("./prep");
    const plan = await draftPlan({ settings, facts, history: [] });
    expect(plan.agenda).toEqual(["問出核決權限"]);
    expect(plan.idealPath).toHaveLength(1);
    expect(plan.edgeCases).toEqual([{ trigger: "說要再研究", move: "直接約下次" }]);
  });

  it("feeds the conversation to the model alongside the account facts", async () => {
    resolveWith({ agenda: [], idealPath: [], edgeCases: [], target: "", batna: "", floor: "" });
    const { draftPlan } = await import("./prep");
    await draftPlan({
      settings,
      facts,
      history: [
        { role: "user", content: "我要探預算" },
        { role: "assistant", content: "那就從擴編切入" },
      ],
    });
    const prompt = generateObjectResilient.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("和運租車");
    expect(prompt).toContain("ME: 我要探預算");
    expect(prompt).toContain("COACH: 那就從擴編切入");
  });
});
