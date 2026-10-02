import { beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, JSONParseError, RetryError, TypeValidationError } from "ai";

vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { log } from "../log";
import { logAiError } from "./errors";

/** The fields of the one WARN line `logAiError` wrote. */
function warned(): Record<string, unknown> {
  const calls = vi.mocked(log.warn).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}

/** Everything that reached the log, WARN and DEBUG, as one string. */
function everythingLogged(): string {
  return JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.debug).mock.calls]);
}

function apiCallError(statusCode: number, body?: unknown): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://cloud.example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logAiError", () => {
  /** WebKit's refused CORS preflight. The name alone ("TypeError") is what the
   *  field log used to say, and it says nothing. */
  it("keeps the message of a transport failure", () => {
    logAiError("scope", { rawChars: 12 }, new TypeError("Load failed"));
    expect(warned()).toMatchObject({ rawChars: 12, error: "TypeError", message: "Load failed" });
  });

  it("collapses whitespace and caps a long message", () => {
    logAiError("scope", {}, new Error(`a\n\n  b${"x".repeat(500)}`));
    const message = warned().message as string;
    expect(message.startsWith("a b")).toBe(true);
    expect(message.length).toBe(160);
  });

  /** The privacy guard: these SDK errors put the model's output in their message,
   *  and the model's output is the user's dictation. */
  it("never logs the message of an error that embeds model output", () => {
    logAiError(
      "scope",
      {},
      new JSONParseError({ text: "SECRET dictation", cause: new Error("x") }),
    );
    logAiError(
      "scope",
      {},
      new TypeValidationError({ value: { said: "SECRET dictation" }, cause: new Error("x") }),
    );
    for (const [, fields] of vi.mocked(log.warn).mock.calls) {
      expect(fields).not.toHaveProperty("message");
    }
    expect(everythingLogged()).not.toContain("SECRET");
  });

  it("keeps an API error's status and provider error code", () => {
    logAiError("scope", {}, apiCallError(429, { error: { code: "rate_limit_exceeded" } }));
    expect(warned()).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    expect(warned()).not.toHaveProperty("message");
  });

  /** An exhausted retry used to log as `error=AI_RetryError` and nothing else:
   *  the status that explains it sits on the last attempt. */
  it("unwraps a RetryError to the last attempt's status", () => {
    const err = new RetryError({
      message: "Failed after 3 attempts. Last error: SECRET provider text",
      reason: "maxRetriesExceeded",
      errors: [apiCallError(503), apiCallError(503), apiCallError(503)],
    });
    logAiError("scope", {}, err);
    expect(warned()).toMatchObject({
      error: "AI_RetryError",
      attempts: 3,
      lastError: "AI_APICallError",
      status: 503,
    });
    expect(warned()).not.toHaveProperty("message");
    expect(everythingLogged()).not.toContain("SECRET");
  });
});
