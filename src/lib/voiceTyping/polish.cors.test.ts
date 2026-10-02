import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";

// End to end through the REAL `ai` + `@ai-sdk/openai-compatible` + provider.ts +
// ai/settings.ts, with only the network and the log file faked. Its own file because
// polish.test.ts mocks `../ai/settings` for the whole module.
vi.mock("../cloud/client", () => ({
  cloudToken: () => "test-token",
  CLOUD_URL: "https://cloud.example.test",
}));
vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { log } from "../log";
import { POLISH_TIMEOUT_MS, polishTranscript, polishTranscriptOutcome } from "./polish";

const settings = {
  voiceTypingPolish: true,
  llmProviders: { realtime: "parley", deep: "parley" },
  models: { parley: { realtime: "parley-fast", deep: "parley-smart" } },
  reasoningEffort: { realtime: "low", deep: "medium" },
  parleyApiKey: "",
} as unknown as Settings;

const RAW = "um so I think we should uh ship it on friday";
const POLISHED = "I think we should ship it on Friday.";

/** Parley Cloud's Access-Control-Allow-Headers, verbatim (lower-cased). */
const ALLOWED = new Set(["content-type", "authorization", "idempotency-key", "x-parley-client"]);

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A fetch that behaves like WKWebView against Parley Cloud: any request header outside
 * the server's allow-list fails the CORS preflight, and WebKit reports that as a bare
 * `TypeError: Load failed` before the request is ever sent. Chromium would have
 * dropped `user-agent` itself; WebKit does not, which is the whole bug.
 */
function webkitFetch(respond: FetchImpl) {
  const spy = vi.fn<FetchImpl>(async (input, init) => {
    for (const name of new Headers(init?.headers).keys()) {
      if (!ALLOWED.has(name)) throw new TypeError("Load failed");
    }
    if (init?.signal?.aborted) throw init.signal.reason;
    return respond(input, init);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "parley-fast",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Never answers; rejects the way fetch does once its signal aborts. */
const hang: FetchImpl = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("polish against Parley Cloud from a WebKit webview", () => {
  /** The production bug: every hosted polish on macOS failed its preflight, so this
   *  resolved to null (raw text pasted) on every dictation. */
  it("gets past the CORS preflight and returns the polished text", async () => {
    const fetchSpy = webkitFetch(async () => completion(POLISHED));

    await expect(polishTranscript({ raw: RAW, settings })).resolves.toBe(POLISHED);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0];
    expect(String(input)).toBe("https://cloud.example.test/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.has("user-agent")).toBe(false);
    expect(JSON.parse(String(init?.body)).model).toBe("parley-fast");
    expect(log.info).toHaveBeenCalledWith("voice-typing: polished", expect.any(Object));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports the outcome alongside the text", async () => {
    webkitFetch(async () => completion(POLISHED));
    await expect(polishTranscriptOutcome({ raw: RAW, settings })).resolves.toEqual({
      text: POLISHED,
      outcome: "polished",
    });
  });

  /** What the field log said for every attempt: `error=TypeError` and nothing
   *  else. The message, the provider and the model are what make it diagnosable. */
  it("logs a transport failure with its message, provider and model", async () => {
    const fetchSpy = vi.fn<FetchImpl>(async () => {
      throw new TypeError("Load failed");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(polishTranscriptOutcome({ raw: RAW, settings })).resolves.toEqual({
      text: null,
      outcome: "failed",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "voice-typing.polish: failed",
      expect.objectContaining({
        error: "TypeError",
        message: "Load failed",
        provider: "parley",
        model: "parley-fast",
        outcome: "failed",
        rawChars: RAW.length,
      }),
    );
    expect(vi.mocked(log.warn).mock.calls[0][1]).toHaveProperty("ms");
  });

  /** A retry's first backoff is 2 s of a 4 s budget: one attempt, and the status
   *  in the log rather than a TimeoutError. */
  it("does not retry a 5xx, and logs its status", async () => {
    const body = JSON.stringify({ error: { message: "upstream down", type: "server_error" } });
    const fetchSpy = webkitFetch(
      async () =>
        new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
    );

    await expect(polishTranscriptOutcome({ raw: RAW, settings })).resolves.toEqual({
      text: null,
      outcome: "failed",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "voice-typing.polish: failed",
      expect.objectContaining({ status: 500, outcome: "failed" }),
    );
  });

  it("gives up after the budget and says it timed out", async () => {
    vi.useFakeTimers();
    const fetchSpy = webkitFetch(hang);

    let settled = false;
    const pending = polishTranscriptOutcome({ raw: RAW, settings }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(POLISH_TIMEOUT_MS - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ text: null, outcome: "timedOut" });
    expect(log.warn).toHaveBeenCalledWith(
      "voice-typing.polish: failed",
      expect.objectContaining({ outcome: "timedOut", provider: "parley" }),
    );
  });

  /** ESC during "polishing": the caller walked away, nothing failed. */
  it("resolves to cancelled when the caller aborts, without a WARN", async () => {
    const fetchSpy = webkitFetch(hang);
    const controller = new AbortController();

    const pending = polishTranscriptOutcome({ raw: RAW, settings, signal: controller.signal });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toEqual({ text: null, outcome: "cancelled" });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("voice-typing: polish cancelled", expect.any(Object));
  });

  it("does not send anything when the caller has already cancelled", async () => {
    const fetchSpy = webkitFetch(async () => completion(POLISHED));
    const controller = new AbortController();
    controller.abort();

    await expect(
      polishTranscriptOutcome({ raw: RAW, settings, signal: controller.signal }),
    ).resolves.toEqual({ text: null, outcome: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names why it did not run: off, or too short", async () => {
    const fetchSpy = webkitFetch(async () => completion(POLISHED));
    await expect(
      polishTranscriptOutcome({ raw: RAW, settings: { ...settings, voiceTypingPolish: false } }),
    ).resolves.toEqual({ text: null, outcome: "off" });
    await expect(polishTranscriptOutcome({ raw: "ok", settings })).resolves.toEqual({
      text: null,
      outcome: "tooShort",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the guard's reason when it refuses the answer", async () => {
    webkitFetch(async () => completion("Sure!"));
    await expect(polishTranscriptOutcome({ raw: RAW, settings })).resolves.toEqual({
      text: null,
      outcome: "rejectedLength",
    });
    expect(log.info).toHaveBeenCalledWith(
      "voice-typing: polish rejected, keeping raw",
      expect.objectContaining({ outcome: "rejectedLength" }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
