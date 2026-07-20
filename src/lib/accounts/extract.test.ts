import { beforeEach, describe, expect, it, vi } from "vitest";

// extract.ts pulls in `log` (touches window / Tauri IPC in non-test paths)
// plus the real LLM call — stub them all; we test the prompt assembly and
// normalization around the model, not the model.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn() }));
const generateMock = vi.fn();
vi.mock("../ai/generate", () => ({
  generateObjectResilient: (...args: unknown[]) => generateMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

import { extractClaimOps } from "./extract";
import type { Settings } from "../types";
import type { Company, Thread } from "./types";

const settings = {
  language: "zh-TW",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
} as unknown as Settings;

const company: Company = {
  id: "co",
  name: "AI3",
  aliases: [],
  note: "",
  createdAt: 0,
  archived: false,
};

function thread(over: Partial<Thread>): Thread {
  return {
    id: "th",
    companyId: "co",
    companyRoles: [],
    kind: "sales",
    name: "報價案",
    status: "active",
    stage: "discovery",
    committee: [],
    createdAt: 0,
    ...over,
  };
}

function emptyResult(newClaims: unknown[] = []) {
  return {
    object: { newPersons: [], newClaims, claimUpdates: [] },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("extractClaimOps (post-B6: no slot tagging)", () => {
  beforeEach(() => generateMock.mockClear());

  it("tells the model what the live board already captured, and deep-pass claims carry no slotIds", async () => {
    generateMock.mockResolvedValueOnce(
      emptyResult([
        {
          category: "risk",
          text: "尖峰時段漏接",
          subjects: [],
          side: "theirs",
          layer: "",
          quote: "",
        },
      ])
    );
    const ops = await extractClaimOps({
      settings,
      company,
      persons: [],
      threads: [thread({})],
      existingClaims: [],
      sourceText: "逐字稿",
      sourceLabel: "meeting transcript",
      capturedTexts: ["旺季每天五六次改單", "決策者是營運副總"],
    });
    const prompt = (generateMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Already captured on the live board");
    expect(prompt).toContain("旺季每天五六次改單");
    // The live pass is the only transcript→slot channel now.
    expect(prompt).not.toContain("Gap-board slots");
    expect(ops.newClaims[0].slotIds).toEqual([]);
  });

  it("no captured texts → no captured digest in the prompt", async () => {
    generateMock.mockResolvedValueOnce(emptyResult());
    await extractClaimOps({
      settings,
      company,
      persons: [],
      threads: [thread({})],
      existingClaims: [],
      sourceText: "notes",
      sourceLabel: "notes",
    });
    const prompt = (generateMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Already captured");
  });
});
