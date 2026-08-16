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

const settings = {
  language: "zh-TW",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
} as unknown as Settings;

function input(over: Partial<PrepDraftInput> = {}): PrepDraftInput {
  return {
    folder: "和運租車",
    stageName: "議價",
    stageGoal: "",
    exitCriteria: [],
    slots: [],
    meetings: [],
    context: "",
    ...over,
  };
}

describe("buildPrepPrompt", () => {
  it("sends the stage's board slots with their hints", () => {
    const prompt = buildPrepPrompt(
      settings,
      input({
        slots: [
          { id: "a", label: "預算", hint: "誰出錢、多少" },
          { id: "b", label: "決策鏈", hint: "誰拍板" },
        ],
      })
    );
    expect(prompt).toContain("What this stage's board wants covered");
    expect(prompt).toContain("預算：誰出錢、多少");
    expect(prompt).toContain("決策鏈：誰拍板");
  });

  it("names the customer and the stage's exit criteria", () => {
    const prompt = buildPrepPrompt(settings, input({ exitCriteria: ["報價已送出"] }));
    expect(prompt).toContain("Meeting with: 和運租車");
    expect(prompt).toContain("Stage is finished when");
    expect(prompt).toContain("報價已送出");
  });

  it("lists past calls newest first, capped", () => {
    const prompt = buildPrepPrompt(
      settings,
      input({ meetings: [{ title: "報價討論", createdAt: 86_400_000 }] })
    );
    expect(prompt).toContain("1970-01-02 報價討論");
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
