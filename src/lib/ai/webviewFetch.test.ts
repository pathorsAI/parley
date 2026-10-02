import { afterEach, describe, expect, it, vi } from "vitest";
import { webviewFetch } from "./webviewFetch";

/**
 * The header WebKit refuses to drop. The SDK sets it on every request, and with it
 * in the CORS preflight Parley Cloud's fixed allow-list turned every hosted LLM call
 * from the macOS webview into a bare `TypeError: Load failed`.
 */
const UA = "ai-sdk/openai-compatible/2.0.50 ai-sdk/provider-utils/4.0.29 runtime/browser";

function stubFetch() {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The headers the stubbed fetch actually received, as a Headers instance. */
function sentHeaders(spy: ReturnType<typeof stubFetch>, call = 0): Headers {
  return new Headers(spy.mock.calls[call][1]?.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webviewFetch", () => {
  it("strips user-agent from a plain header record, whatever its casing", async () => {
    const spy = stubFetch();
    await webviewFetch("https://cloud.example.test/v1/chat/completions", {
      headers: { "User-Agent": UA, authorization: "Bearer t" },
    });
    await webviewFetch("https://cloud.example.test/v1/chat/completions", {
      headers: { "user-agent": UA, authorization: "Bearer t" },
    });
    expect(sentHeaders(spy, 0).has("user-agent")).toBe(false);
    expect(sentHeaders(spy, 1).has("user-agent")).toBe(false);
  });

  it("strips user-agent from a Headers instance", async () => {
    const spy = stubFetch();
    await webviewFetch("https://x.test", {
      headers: new Headers({ "user-agent": UA, "content-type": "application/json" }),
    });
    expect(sentHeaders(spy).has("user-agent")).toBe(false);
    expect(sentHeaders(spy).get("content-type")).toBe("application/json");
  });

  it("strips user-agent from an array of pairs", async () => {
    const spy = stubFetch();
    await webviewFetch("https://x.test", {
      headers: [
        ["User-Agent", UA],
        ["Authorization", "Bearer t"],
      ],
    });
    expect(sentHeaders(spy).has("user-agent")).toBe(false);
    expect(sentHeaders(spy).get("authorization")).toBe("Bearer t");
  });

  /** The allow-listed headers are the request: auth and the JSON body type. */
  it("keeps authorization and content-type untouched", async () => {
    const spy = stubFetch();
    await webviewFetch("https://x.test", {
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "user-agent": UA,
      },
    });
    const headers = sentHeaders(spy);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
  });

  /** Dropping the signal would make the polish timeout (and ESC) a no-op. */
  it("passes the URL, method, body and abort signal through", async () => {
    const spy = stubFetch();
    const signal = new AbortController().signal;
    const body = JSON.stringify({ model: "parley-fast" });
    await webviewFetch("https://x.test/v1/chat/completions", {
      method: "POST",
      body,
      signal,
      headers: { "user-agent": UA },
    });
    const [input, init] = spy.mock.calls[0];
    expect(input).toBe("https://x.test/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(body);
    expect(init?.signal).toBe(signal);
  });

  it("forwards a call with no headers exactly as given", async () => {
    const spy = stubFetch();
    const init = { method: "GET" };
    await webviewFetch("https://x.test", init);
    await webviewFetch("https://x.test");
    expect(spy.mock.calls[0]).toEqual(["https://x.test", init]);
    expect(spy.mock.calls[0][1]).toBe(init);
    expect(spy.mock.calls[1]).toEqual(["https://x.test", undefined]);
  });

  /** Resolved per call, not captured at import. */
  it("uses whatever global fetch is installed at call time", async () => {
    const first = stubFetch();
    await webviewFetch("https://x.test", { headers: { a: "1" } });
    const second = stubFetch();
    await webviewFetch("https://x.test", { headers: { a: "2" } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
