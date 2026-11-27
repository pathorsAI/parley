import { describe, expect, it } from "vitest";
import { isRegionRefusal, isRegionRefusalError, isRegionRefusalMessage } from "./region";

/** The region refusals each provider sends from Hong Kong / mainland China. */
const OPENAI_BODY = JSON.stringify({
  error: {
    code: "unsupported_country_region_territory",
    message: "Country, region, or territory not supported",
    param: null,
    type: "request_forbidden",
  },
});
const ANTHROPIC_BODY = JSON.stringify({ type: "error", error: { type: "forbidden", message: "Request not allowed" } });
// Gemini's OpenAI-compatible endpoint wraps the error in a one-element list.
const GEMINI_BODY = JSON.stringify([
  { error: { code: 400, message: "User location is not supported for the API use.", status: "FAILED_PRECONDITION" } },
]);
const GROQ_BODY = JSON.stringify({ error: { message: "Forbidden" } });

/** An `APICallError` nested under the SDK's wrapper, as it is thrown. */
function sdkError(statusCode: number, responseBody: string, message = "Forbidden") {
  const inner = Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody });
  return Object.assign(new Error("Failed after 3 attempts"), { name: "AI_RetryError", lastError: inner });
}

describe("isRegionRefusal", () => {
  it.each([
    ["openai", 403, OPENAI_BODY],
    ["anthropic", 403, ANTHROPIC_BODY],
    ["gemini", 400, GEMINI_BODY],
    ["groq", 403, GROQ_BODY],
  ])("recognises %s's region refusal", (provider, status, body) => {
    expect(isRegionRefusal(provider, status, body)).toBe(true);
    expect(isRegionRefusalError(sdkError(status, body), provider)).toBe(true);
  });

  it("keeps ordinary key refusals as key refusals", () => {
    expect(isRegionRefusal("openai", 401, '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}')).toBe(false);
    expect(isRegionRefusal("openai", 403, '{"error":{"message":"You are not allowed to sample from this model"}}')).toBe(false);
    expect(isRegionRefusal("anthropic", 401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe(false);
    expect(isRegionRefusal("anthropic", 403, '{"error":{"type":"permission_error","message":"This organization has been disabled."}}')).toBe(false);
    expect(isRegionRefusal("anthropic", 403, '{"error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}')).toBe(false);
    expect(isRegionRefusal("gemini", 400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}')).toBe(false);
    expect(isRegionRefusal("groq", 401, '{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}')).toBe(false);
  });

  it("never reads a bare 403 from a gateway or a self-hosted server as a region block", () => {
    expect(isRegionRefusal("openrouter", 403, GROQ_BODY)).toBe(false);
    expect(isRegionRefusal("custom", 403, GROQ_BODY)).toBe(false);
    // Not even with OpenAI's wording: a proxy's location is not the user's.
    expect(isRegionRefusal("custom", 403, OPENAI_BODY)).toBe(false);
    expect(isRegionRefusal("openai", 403, GROQ_BODY)).toBe(false);
  });

  it("works off a flattened describeAiError message too", () => {
    expect(isRegionRefusalMessage(`Forbidden — HTTP 403 — ${GROQ_BODY}`, "groq")).toBe(true);
    expect(isRegionRefusalMessage("Forbidden", "groq")).toBe(false);
    expect(isRegionRefusalMessage(`User location is not supported for the API use. — HTTP 400`, "gemini")).toBe(true);
  });
});
