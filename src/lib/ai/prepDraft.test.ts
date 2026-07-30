import { beforeEach, describe, expect, it, vi } from "vitest";

// prepDraft pulls in `log` (window / Tauri IPC off the test path) and the real
// model call — stub both; what's under test is the prompt assembly and the
// clamping around the model, not the model.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn() }));
const generateMock = vi.fn();
vi.mock("./generate", () => ({
  generateObjectResilient: (...args: unknown[]) => generateMock(...args),
}));

import { buildPrepPrompt, draftPrep, type PrepDraftInput } from "./prepDraft";
import type { Settings } from "../types";
import type { Claim, Company } from "../accounts/types";

const settings = {
  language: "zh-TW",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
} as unknown as Settings;

const company: Company = {
  id: "co",
  name: "和運租車",
  aliases: [],
  note: "",
  createdAt: 0,
  archived: false,
};

function claim(over: Partial<Claim>): Claim {
  return {
    id: "c1",
    companyId: "co",
    subjects: [],
    category: "risk",
    text: "",
    provenance: [],
    confidence: "confirmed",
    status: "active",
    createdAt: 0,
    lastSupportedAt: 0,
    ...over,
  };
}

function input(over: Partial<PrepDraftInput> = {}): PrepDraftInput {
  return {
    company,
    thread: null,
    attendees: [],
    claims: [],
    stageName: "議價",
    stageGoal: "",
    exitCriteria: [],
    gaps: [],
    context: "",
    ...over,
  };
}

describe("buildPrepPrompt", () => {
  it("sends open board slots with their state and fences off the solid ones", () => {
    const prompt = buildPrepPrompt(
      settings,
      input({
        gaps: [
          { label: "預算", hint: "誰出錢、多少", state: "empty" },
          { label: "決策鏈", hint: "誰拍板", state: "thin" },
          { label: "痛點", hint: "卡在哪", state: "solid" },
        ],
      })
    );
    expect(prompt).toContain("[empty] 預算：誰出錢、多少");
    expect(prompt).toContain("[thin] 決策鏈：誰拍板");
    // Solid slots appear ONLY under the do-not-spend-time-here heading, so the
    // draft can't propose chasing something already confirmed.
    expect(prompt).toContain("Already solid");
    expect(prompt).not.toContain("[solid] 痛點");
  });

  it("passes red lines through as claims so the draft can avoid leaking them", () => {
    const prompt = buildPrepPrompt(
      settings,
      input({ claims: [claim({ category: "redline", text: "不可透露現有報價結構" })] })
    );
    expect(prompt).toContain("[redline]");
    expect(prompt).toContain("不可透露現有報價結構");
  });

  it("says so plainly when there is no intel yet", () => {
    expect(buildPrepPrompt(settings, input())).toContain("Intel claims: (none yet)");
  });

  it("omits the notes block when the user typed no background", () => {
    expect(buildPrepPrompt(settings, input())).not.toContain("My own notes");
    expect(buildPrepPrompt(settings, input({ context: "  上次沒回音  " }))).toContain(
      "My own notes for this meeting:\n上次沒回音"
    );
  });
});

describe("draftPrep", () => {
  beforeEach(() => generateMock.mockClear());

  it("trims, de-duplicates and caps what the model over-produces", async () => {
    generateMock.mockResolvedValueOnce({
      object: {
        goals: ["  問出核決權限  ", "問出核決權限", "要到下次會期", "確認競品報價", "第四個"],
        agenda: ["a", "b", "c", "d", "e", "f", "g"],
        objections: ["", "  太貴了 → 回到單次成本  "],
        batna: "  維持現狀  ",
        floor: "",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const draft = await draftPrep({ settings, input: input() });

    expect(draft.goals).toEqual(["問出核決權限", "要到下次會期", "確認競品報價"]);
    expect(draft.agenda).toEqual(["a", "b", "c", "d", "e"]);
    expect(draft.objections).toEqual(["太貴了 → 回到單次成本"]);
    expect(draft.batna).toBe("維持現狀");
    expect(draft.floor).toBe("");
  });

  it("runs on the deep workload — this is a deliberate pre-call action, not a live one", async () => {
    generateMock.mockResolvedValueOnce({
      object: { goals: [], agenda: [], objections: [], batna: "", floor: "" },
      usage: undefined,
    });
    await draftPrep({ settings, input: input() });
    expect((generateMock.mock.calls[0][0] as { workload: string }).workload).toBe("deep");
  });
});
