import { beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, JSONParseError, RetryError, TypeValidationError } from "ai";

vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { log } from "../log";
import { logAiError, stripUrlCredentials } from "./errors";

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

describe("stripUrlCredentials", () => {
  it("keeps the scheme, host and path, and drops the userinfo", () => {
    expect(stripUrlCredentials("at https://alice:s3cr3t@gw.example.test:8443/v1?x=1 now")).toBe(
      "at https://gw.example.test:8443/v1?x=1 now",
    );
    expect(stripUrlCredentials("http://token@localhost:8000")).toBe("http://localhost:8000");
  });

  /** The URL parser ends the userinfo at the authority's last `@`. */
  it("drops a password with an unencoded @ whole", () => {
    expect(stripUrlCredentials("https://alice:p@ss@gw.example.test/v1")).toBe(
      "https://gw.example.test/v1",
    );
  });

  it("strips every URL, and leaves an @ outside the authority alone", () => {
    expect(
      stripUrlCredentials("a://u:p@one.test/x@y and b://two.test/me@there, mail me@example.test"),
    ).toBe("a://one.test/x@y and b://two.test/me@there, mail me@example.test");
  });
});

describe("logAiError", () => {
  /** WebKit's refused CORS preflight. The name alone ("TypeError") is what the
   *  field log used to say, and it says nothing. */
  it("keeps the message of a transport failure", () => {
    logAiError("scope", { rawChars: 12 }, new TypeError("Load failed"));
    expect(warned()).toMatchObject({ rawChars: 12, error: "TypeError", message: "Load failed" });
  });

  /** WebView2 refuses a custom base URL with basic-auth credentials in it, and
   *  its TypeError quotes the URL whole. The password must not reach the log;
   *  the host is what explains the failure. */
  it("strips credentials from a URL in the message, before capping it", () => {
    logAiError(
      "scope",
      {},
      new TypeError(
        "Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://alice:s3cr3t@gw.example.test/v1/chat/completions",
      ),
    );
    expect(everythingLogged()).not.toContain("s3cr3t");
    expect(everythingLogged()).not.toContain("alice");
    expect(warned().message).toContain("https://gw.example.test/v1/chat/comp");
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
