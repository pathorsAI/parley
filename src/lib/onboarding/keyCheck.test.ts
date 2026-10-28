import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../ipc/commands", () => ({ verifySttKey: vi.fn() }));
vi.mock("../ai/connectionTest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/connectionTest")>()),
  runConnectionTest: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings } from "../types";
import * as ipc from "../ipc/commands";
import { runConnectionTest } from "../ai/connectionTest";
import { checkModelKeys, llmConfigured, llmFailureBlocks } from "./keyCheck";

const base = useStore.getState().settings;
const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });
const verify = vi.mocked(ipc.verifySttKey);
const llmTest = vi.mocked(runConnectionTest);

afterEach(() => vi.clearAllMocks());

describe("llmFailureBlocks", () => {
  it("blocks on a refused key, a 404 or an unknown model", () => {
    expect(llmFailureBlocks("settings.provider.test.rejectedKey", false)).toBe(true);
    expect(llmFailureBlocks("settings.provider.test.notFound", false)).toBe(true);
    expect(llmFailureBlocks("settings.provider.test.unknownModel", false)).toBe(true);
  });

  it("lets an unreachable big provider through, but not a self-hosted one", () => {
    expect(llmFailureBlocks("settings.provider.test.unreachable", false)).toBe(false);
    expect(llmFailureBlocks("settings.provider.test.unreachable", true)).toBe(true);
  });

  it("lets timeouts and other errors through", () => {
    expect(llmFailureBlocks("settings.provider.test.timeout", false)).toBe(false);
    expect(llmFailureBlocks("settings.provider.test.raw", true)).toBe(false);
  });
});

describe("llmConfigured", () => {
  it("only tests an LLM that has a key (or a URL) filled in", () => {
    const groq = { llmProviders: { realtime: "groq", deep: "groq" } } as const;
    expect(llmConfigured(settingsFor({ ...groq, groqApiKey: "" }))).toBe(false);
    expect(llmConfigured(settingsFor({ ...groq, groqApiKey: " gsk_x " }))).toBe(true);
    expect(llmConfigured(settingsFor({ llmProviders: { realtime: "parley", deep: "parley" } }))).toBe(false);
  });
});

describe("checkModelKeys", () => {
  const soniox = settingsFor({
    transcriptionProvider: "soniox",
    sonioxApiKey: "bad",
    llmProviders: { realtime: "groq", deep: "groq" },
    groqApiKey: "",
  });

  it("reports a refused transcription key", async () => {
    verify.mockResolvedValue("rejected");
    const problems = await checkModelKeys(soniox);
    expect(verify).toHaveBeenCalledWith({ provider: "soniox", key: "bad" });
    expect(problems.stt?.key).toBe("onboarding.model.sttKeyRejected");
    expect(problems.llm).toBeUndefined();
    expect(llmTest).not.toHaveBeenCalled();
  });

  it("finds nothing wrong when the vendor can't be reached", async () => {
    verify.mockResolvedValue("unknown");
    expect(await checkModelKeys(soniox)).toEqual({});
  });

  it("reports a refused AI key alongside", async () => {
    verify.mockResolvedValue("accepted");
    llmTest.mockResolvedValue({ ok: false, error: { key: "settings.provider.test.rejectedKey" } });
    const problems = await checkModelKeys({ ...soniox, groqApiKey: "gsk_bad" });
    expect(problems.stt).toBeUndefined();
    expect(problems.llm?.key).toBe("settings.provider.test.rejectedKey");
  });

  it("checks nothing for an on-device model and no AI key", async () => {
    const problems = await checkModelKeys(settingsFor({ transcriptionProvider: "local", llmProviders: soniox.llmProviders, groqApiKey: "" }));
    expect(problems).toEqual({});
    expect(verify).not.toHaveBeenCalled();
  });
});
