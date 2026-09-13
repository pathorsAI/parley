import { describe, expect, it } from "vitest";
import { classifyConnectionError } from "./connectionTest";

/**
 * The "Test connection" button exists so a self-hosted endpoint fails in
 * Settings, in a sentence, instead of mid-meeting as `AI_APICallError`. That
 * only holds if the classification is right, so these fabricate the error
 * shapes the SDK and the webview actually hand us.
 */
const CTX = { host: "localhost:8000", model: "my-model-7b" };

/** An `APICallError`-shaped failure: the SDK's wrapper around a real HTTP reply. */
function apiCallError(statusCode: number, responseBody = ""): Error {
  const err = new Error(`Failed to process error response: ${statusCode}`);
  err.name = "AI_APICallError";
  return Object.assign(err, { statusCode, responseBody, url: "http://localhost:8000/v1" });
}

/** The same, but nested under `cause` — where the SDK usually puts it. */
function wrapped(inner: Error): Error {
  const outer = new Error("Failed to process successful response");
  outer.name = "AI_APICallError";
  return Object.assign(outer, { cause: inner });
}

describe("classifyConnectionError", () => {
  it("reads an unreachable host off a bare fetch TypeError", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyConnectionError(err, CTX)).toEqual({
      key: "settings.provider.test.unreachable",
      vars: { host: "localhost:8000" },
    });
  });

  it("reads an unreachable host off WebKit's 'Load failed' too", () => {
    // Tauri on macOS runs WKWebView, whose wording differs from Chromium's.
    const err = new TypeError("Load failed");
    expect(classifyConnectionError(err, CTX).key).toBe("settings.provider.test.unreachable");
  });

  it("treats a connection-refused errno as unreachable", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), {
      code: "ECONNREFUSED",
    });
    expect(classifyConnectionError(err, CTX).key).toBe("settings.provider.test.unreachable");
  });

  it("finds the transport failure through the SDK's wrapper", () => {
    expect(classifyConnectionError(wrapped(new TypeError("Failed to fetch")), CTX).key).toBe(
      "settings.provider.test.unreachable"
    );
  });

  it("blames the key on 401 and on 403", () => {
    for (const status of [401, 403]) {
      expect(classifyConnectionError(apiCallError(status), CTX).key).toBe(
        "settings.provider.test.rejectedKey"
      );
    }
  });

  it("blames the URL on 404, even when the body mentions a model", () => {
    // A gateway mounted somewhere other than the path the user typed answers
    // 404 with a message about models — reporting that as a model problem sends
    // the user to fix the wrong field.
    const err = apiCallError(404, '{"error":{"message":"model not found"}}');
    expect(classifyConnectionError(err, CTX).key).toBe("settings.provider.test.notFound");
  });

  it("blames the model id on 400", () => {
    expect(classifyConnectionError(apiCallError(400), CTX)).toEqual({
      key: "settings.provider.test.unknownModel",
      vars: { model: "my-model-7b" },
    });
  });

  it("blames the model id when an unusual status carries a model complaint", () => {
    const err = apiCallError(422, '{"error":{"message":"The model `my-model-7b` does not exist"}}');
    expect(classifyConnectionError(err, CTX)).toEqual({
      key: "settings.provider.test.unknownModel",
      vars: { model: "my-model-7b" },
    });
  });

  it("reports our own timeout as a timeout", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    expect(classifyConnectionError(err, CTX)).toEqual({ key: "settings.provider.test.timeout" });
  });

  it("reports an aborted request as a timeout even when wrapped by the SDK", () => {
    const abort = new Error("signal is aborted without reason");
    abort.name = "AbortError";
    expect(classifyConnectionError(wrapped(abort), CTX).key).toBe("settings.provider.test.timeout");
  });

  it("falls back to the raw message, on one line", () => {
    const err = new Error("Something\n  unexpected\thappened   on the way");
    expect(classifyConnectionError(err, CTX)).toEqual({
      key: "settings.provider.test.raw",
      vars: { error: "Something unexpected happened on the way" },
    });
  });

  it("truncates a wall-of-text failure instead of pasting it into the UI", () => {
    const err = new Error("x".repeat(500));
    const msg = classifyConnectionError(err, CTX);
    expect(msg.key).toBe("settings.provider.test.raw");
    expect(msg.vars?.error.length).toBeLessThanOrEqual(201);
    expect(msg.vars?.error.endsWith("…")).toBe(true);
  });

  it("survives a non-Error rejection", () => {
    expect(classifyConnectionError("kaboom", CTX)).toEqual({
      key: "settings.provider.test.raw",
      vars: { error: "kaboom" },
    });
  });
});
