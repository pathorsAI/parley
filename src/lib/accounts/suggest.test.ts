import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn() }));
vi.mock("../ai/provider", () => ({ JSON_MODE_INSTRUCTION: "" }));
const generateMock = vi.fn();
vi.mock("../ai/generate", () => ({
  generateObjectResilient: (...args: unknown[]) => generateMock(...args),
}));

import { suggestSlotQuestions } from "./suggest";
import type { SlotDef } from "./bundles";
import type { Settings } from "../types";

const settings = {
  language: "zh-TW",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
} as unknown as Settings;

const slot: SlotDef = {
  id: "discovery.implication",
  label: "I（Implication）",
  hint: "痛不解決的量化代價",
  query: { categories: ["risk"] },
};

describe("suggestSlotQuestions (#148)", () => {
  beforeEach(() => generateMock.mockClear());

  it("rides the realtime lane, feeds knowns + tail, caps at 3 non-empty questions", async () => {
    generateMock.mockResolvedValueOnce({
      object: {
        questions: [
          { reply: "剛剛您提到尖峰漏接——一通大概是多少營業額？", consideration: "抓單價" },
          { reply: " ", consideration: "空的要被丟掉" },
          { reply: "Q2", consideration: "c2" },
          { reply: "Q3", consideration: "c3" },
          { reply: "Q4", consideration: "c4" },
        ],
      },
      usage: {},
    });
    const out = await suggestSlotQuestions({
      settings,
      stage: "discovery",
      slot,
      knownTexts: ["每月漏接約 100 通"],
      transcriptTail: "對方: 尖峰的時候真的接不完",
    });
    expect(out).toHaveLength(3);
    expect(out[0].reply).toContain("尖峰漏接");
    const call = generateMock.mock.calls[0][0] as { workload: string; prompt: string };
    expect(call.workload).toBe("realtime");
    expect(call.prompt).toContain("每月漏接約 100 通"); // knowns forwarded
    expect(call.prompt).toContain("尖峰的時候真的接不完"); // tail forwarded
  });

  it("pre-call (no transcript) asks for openers instead", async () => {
    generateMock.mockResolvedValueOnce({ object: { questions: [] }, usage: {} });
    await suggestSlotQuestions({
      settings,
      stage: "prospecting",
      slot,
      knownTexts: [],
      transcriptTail: "",
    });
    const call = generateMock.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain("not started");
  });
});
