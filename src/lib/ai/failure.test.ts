import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, Settings } from "../types";

// hasProviderKey reaches for the cloud session token to decide whether the
// hosted provider is usable; these tests never touch it.
vi.mock("../cloud/client", () => ({ cloudToken: () => null }));

import { classifyAiFailure } from "./failure";

function settingsFor(provider: LlmProvider, key: string): Settings {
  return {
    llmProviders: { realtime: provider, deep: provider },
    models: { [provider]: { realtime: "m-fast", deep: "m-smart" } },
    anthropicApiKey: provider === "anthropic" ? key : "",
    groqApiKey: provider === "groq" ? key : "",
  } as unknown as Settings;
}

/** The shape the AI SDK actually throws: a wrapper whose `cause` holds the real
 *  provider message. */
function apiError(message: string, statusCode?: number) {
  const cause = Object.assign(new Error(message), statusCode ? { statusCode } : {});
  return Object.assign(new Error("AI_APICallError"), { cause });
}

describe("classifyAiFailure", () => {
  it("reads Anthropic's bare `invalid x-api-key` as an auth problem, not a mystery", () => {
    // Exactly what the pre-flight coach showed the user before this existed.
    const f = classifyAiFailure(apiError("invalid x-api-key", 401), settingsFor("anthropic", "sk-ant-whatever"), "deep");
    expect(f.kind).toBe("auth");
    expect(f.fixInSettings).toBe(true);
    expect(f.providerLabel).toBe("Claude");
    expect(f.detail).toContain("invalid x-api-key");
  });

  it("calls out a missing key before blaming the request", () => {
    const f = classifyAiFailure(apiError("invalid x-api-key", 401), settingsFor("anthropic", "   "), "deep");
    expect(f.kind).toBe("missingKey");
    expect(f.fixInSettings).toBe(true);
  });

  it("separates rate limits, which retrying can fix, from key problems", () => {
    const f = classifyAiFailure(apiError("rate limit exceeded", 429), settingsFor("groq", "gsk_x"), "realtime");
    expect(f.kind).toBe("rate");
    expect(f.fixInSettings).toBe(false);
  });

  it("names an unavailable model", () => {
    const f = classifyAiFailure(apiError("model not found", 404), settingsFor("groq", "gsk_x"), "deep");
    expect(f.kind).toBe("model");
    expect(f.fixInSettings).toBe(true);
  });

  it("falls back to generic without pretending to know the cause", () => {
    const f = classifyAiFailure(apiError("socket hang up"), settingsFor("groq", "gsk_x"), "deep");
    expect(f.kind).toBe("generic");
    expect(f.fixInSettings).toBe(false);
  });
});

describe("classifyAiFailure — region refusals", () => {
  function sdk403(responseBody: string, statusCode = 403) {
    const cause = Object.assign(new Error("Forbidden"), { statusCode, responseBody });
    return Object.assign(new Error("AI_APICallError"), { cause });
  }

  it("tells a region block apart from a rejected key", () => {
    const f = classifyAiFailure(
      sdk403('{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}'),
      settingsFor("anthropic", "sk-ant-x"),
      "deep"
    );
    expect(f.kind).toBe("regionUnsupported");
    expect(f.fixInSettings).toBe(true);
  });

  it("reads Groq's bare 403 Forbidden as a region block, but its 401 as a bad key", () => {
    expect(classifyAiFailure(sdk403('{"error":{"message":"Forbidden"}}'), settingsFor("groq", "gsk_x"), "deep").kind).toBe(
      "regionUnsupported"
    );
    expect(
      classifyAiFailure(
        sdk403('{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}', 401),
        settingsFor("groq", "gsk_x"),
        "deep"
      ).kind
    ).toBe("auth");
  });

  it("keeps an Anthropic permission error a key problem", () => {
    const f = classifyAiFailure(
      sdk403('{"type":"error","error":{"type":"permission_error","message":"This organization has been disabled."}}'),
      settingsFor("anthropic", "sk-ant-x"),
      "deep"
    );
    expect(f.kind).toBe("auth");
  });
});
