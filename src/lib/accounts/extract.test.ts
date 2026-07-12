import { beforeEach, describe, expect, it, vi } from "vitest";

// extract.ts pulls in `log` and bundle override reading (both touch window /
// Tauri IPC in their non-test paths) plus the real LLM call — stub them all;
// we test the prompt assembly and normalization around the model, not the model.
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

describe("extractClaimOps slot tagging (#146)", () => {
  beforeEach(() => generateMock.mockClear());

  it("injects the linked thread's stage slots and whitelists returned slotIds", async () => {
    generateMock.mockResolvedValueOnce(
      emptyResult([
        {
          category: "risk",
          text: "尖峰時段漏接",
          subjects: [],
          side: "theirs",
          layer: "",
          quote: "",
          slotIds: ["discovery.problem", "bogus.slot"],
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
      threadId: "th",
    });
    const prompt = (generateMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Gap-board slots");
    expect(prompt).toContain("discovery.problem");
    // The model must not invent ids outside the offered list.
    expect(ops.newClaims[0].slotIds).toEqual(["discovery.problem"]);
  });

  it("company-level feed (no threadId) offers the union of active sales threads' stages", async () => {
    generateMock.mockResolvedValueOnce(emptyResult());
    await extractClaimOps({
      settings,
      company,
      persons: [],
      threads: [
        thread({ id: "t1", stage: "prospecting" }),
        thread({ id: "t2", stage: "discovery" }),
        thread({ id: "t3", stage: "demo", status: "lost" }), // inactive → excluded
        thread({ id: "t4", kind: "channel", stage: undefined }), // non-sales → excluded
      ],
      existingClaims: [],
      sourceText: "notes",
      sourceLabel: "notes",
    });
    const prompt = (generateMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("prospecting.identity");
    expect(prompt).toContain("discovery.problem");
    expect(prompt).not.toContain("demo.c0");
  });

  it("no bundled stage in scope → no slot digest, and any returned ids are dropped", async () => {
    generateMock.mockResolvedValueOnce(
      emptyResult([
        {
          category: "goal",
          text: "想上白標",
          subjects: [],
          side: "theirs",
          layer: "",
          quote: "",
          slotIds: ["discovery.problem"],
        },
      ])
    );
    const ops = await extractClaimOps({
      settings,
      company,
      persons: [],
      threads: [thread({ kind: "other", stage: undefined })],
      existingClaims: [],
      sourceText: "notes",
      sourceLabel: "notes",
    });
    const prompt = (generateMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Gap-board slots");
    expect(ops.newClaims[0].slotIds).toEqual([]);
  });
});
