import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LlmProvider, Settings } from "../types";

// The provider factories are the only thing under test: we care about the
// credential handed to them, not about talking to anyone. Declared inside the
// (hoisted) mock factories, then pulled back out below.
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => () => ({ id: "anthropic-model" })),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({ chatModel: () => ({ id: "oai-model" }) })),
}));
vi.mock("../cloud/client", () => ({ cloudToken: () => null, CLOUD_URL: "https://example.test" }));

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getModel } from "./provider";

/**
 * Regression guard for the failure the pre-flight coach surfaced as
 * "AI_APICallError: invalid x-api-key": a key pasted with a trailing space or
 * newline passed the `hasProviderKey` gate (which trims) and then went out in
 * the header untrimmed. The provider's reply named the KEY as wrong rather than
 * the whitespace, so there was nothing actionable in it.
 */
function settingsFor(provider: LlmProvider, keyField: string, key: string): Settings {
  return {
    llmProviders: { realtime: provider, deep: provider },
    models: { [provider]: { realtime: "m-fast", deep: "m-smart" } },
    reasoningEffort: { realtime: "low", deep: "medium" },
    [keyField]: key,
  } as unknown as Settings;
}

const anthropicMock = vi.mocked(createAnthropic);
const oaiMock = vi.mocked(createOpenAICompatible);

describe("getModel credential handling", () => {
  beforeEach(() => {
    anthropicMock.mockClear();
    oaiMock.mockClear();
  });

  it("trims a pasted Anthropic key before it reaches the SDK", () => {
    getModel(settingsFor("anthropic", "anthropicApiKey", "  sk-ant-abc123\n"), "deep");
    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(anthropicMock.mock.calls[0][0]).toMatchObject({ apiKey: "sk-ant-abc123" });
  });

  it("trims openai-compatible keys too", () => {
    getModel(settingsFor("groq", "groqApiKey", "gsk_abc123 "), "realtime");
    expect(oaiMock).toHaveBeenCalledTimes(1);
    expect(oaiMock.mock.calls[0][0]).toMatchObject({ apiKey: "gsk_abc123" });
  });

  it("leaves a clean key exactly as typed", () => {
    getModel(settingsFor("anthropic", "anthropicApiKey", "sk-ant-clean"), "realtime");
    expect(anthropicMock.mock.calls[0][0]).toMatchObject({ apiKey: "sk-ant-clean" });
  });
});

/**
 * The "custom" provider is the only one whose endpoint the registry does not
 * know: it comes from Settings. Two things must hold — the URL is used as typed
 * (minus trailing slashes; no `/v1` invented for the user), and a blank one is
 * refused loudly rather than turned into a request to a relative path inside
 * the webview, whose HTML 404 body fails as "Unexpected token '<'".
 */
describe("getModel with a user-supplied base URL", () => {
  beforeEach(() => oaiMock.mockClear());

  function customSettings(customBaseUrl: string, customApiKey = ""): Settings {
    return {
      llmProviders: { realtime: "custom", deep: "custom" },
      models: { custom: { realtime: "my-model", deep: "my-model" } },
      reasoningEffort: { realtime: "low", deep: "medium" },
      customBaseUrl,
      customApiKey,
    } as unknown as Settings;
  }

  it("uses the typed URL verbatim, minus trailing slashes", () => {
    getModel(customSettings("  http://localhost:8000/v1//  "), "realtime");
    expect(oaiMock.mock.calls[0][0]).toMatchObject({ baseURL: "http://localhost:8000/v1" });
  });

  it("sends a filler credential when the server takes no key", () => {
    getModel(customSettings("http://localhost:8000/v1"), "deep");
    expect(oaiMock.mock.calls[0][0]).toMatchObject({ apiKey: "no-key" });
  });

  it("sends the key when there is one", () => {
    getModel(customSettings("http://localhost:8000/v1", " sk-mine\n"), "deep");
    expect(oaiMock.mock.calls[0][0]).toMatchObject({ apiKey: "sk-mine" });
  });

  it("never sends json_schema to an unknown gateway", () => {
    getModel(customSettings("http://localhost:8000/v1"), "deep");
    expect(oaiMock.mock.calls[0][0]).toMatchObject({ supportsStructuredOutputs: false });
  });

  it("refuses to build a model when the base URL is blank", () => {
    expect(() => getModel(customSettings("   "), "deep")).toThrow(/base URL/i);
    expect(oaiMock).not.toHaveBeenCalled();
  });
});
