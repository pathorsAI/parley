import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  CHAT_RETRY_POLICY,
  ConcurrencyGate,
  createHostedChatFetch,
  hostedChatFetch,
  hostedChatGates,
  parseRetryAfter,
  retryDelayMs,
  type HostedChatFetchDeps,
} from "./hostedChat";

vi.mock("../log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const P = CHAT_RETRY_POLICY;

describe("retryDelayMs", () => {
  it("floors a 429 at 2/4/8 s and gives up after three retries", () => {
    expect(retryDelayMs(P, 429, 0, null, 0)).toBe(2_000);
    expect(retryDelayMs(P, 429, 1, null, 0)).toBe(4_000);
    expect(retryDelayMs(P, 429, 2, null, 0)).toBe(8_000);
    expect(retryDelayMs(P, 429, 3, null, 0)).toBeNull();
  });

  it("honours a longer Retry-After but never below the floor", () => {
    expect(retryDelayMs(P, 429, 0, 12_000, 0)).toBe(12_000);
    expect(retryDelayMs(P, 429, 2, 1_000, 0)).toBe(8_000);
  });

  it("caps a single wait at 30 s, then adds up to 50% jitter", () => {
    expect(retryDelayMs(P, 429, 0, 120_000, 0)).toBe(30_000);
    expect(retryDelayMs(P, 429, 0, 120_000, 0.999)).toBeCloseTo(44_985, 0);
    expect(retryDelayMs(P, 429, 0, null, 0.5)).toBe(2_500);
  });

  it("retries a 502 twice at 2 s and 4 s", () => {
    expect(retryDelayMs(P, 502, 0, 60_000, 0)).toBe(2_000);
    expect(retryDelayMs(P, 502, 1, null, 0)).toBe(4_000);
    expect(retryDelayMs(P, 502, 2, null, 0)).toBeNull();
  });

  it("retries nothing else", () => {
    for (const status of [200, 400, 401, 402, 404, 500, 503, 504]) {
      expect(retryDelayMs(P, status, 0, 1_000, 0)).toBeNull();
    }
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("7")).toBe(7_000);
    expect(parseRetryAfter(" 1.5 ")).toBe(1_500);
  });

  it("reads an HTTP date relative to now, never negative", () => {
    const now = Date.parse("Thu, 22 Oct 2026 15:55:00 GMT");
    expect(parseRetryAfter("Thu, 22 Oct 2026 15:55:20 GMT", now)).toBe(20_000);
    expect(parseRetryAfter("Thu, 22 Oct 2026 15:54:00 GMT", now)).toBe(0);
  });

  it("ignores an absent or unreadable header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-3")).toBeNull();
  });
});

describe("ConcurrencyGate", () => {
  it("admits `limit` holders and queues the rest in arrival order", async () => {
    const gate = new ConcurrencyGate(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    const order: number[] = [];
    const w3 = gate.acquire().then((r) => (order.push(3), r));
    const w4 = gate.acquire().then((r) => (order.push(4), r));
    expect(gate.inFlight).toBe(2);
    expect(gate.queued).toBe(2);

    r1();
    const r3 = await w3;
    expect(order).toEqual([3]);
    r2();
    const r4 = await w4;
    expect(order).toEqual([3, 4]);
    expect(gate.inFlight).toBe(2);

    r3();
    r4();
    expect(gate.inFlight).toBe(0);
  });

  it("ignores a second release of the same slot", async () => {
    const gate = new ConcurrencyGate(1);
    const r = await gate.acquire();
    r();
    r();
    expect(gate.inFlight).toBe(0);
    await gate.acquire();
    expect(gate.inFlight).toBe(1);
  });

  it("drops an aborted waiter from the queue", async () => {
    const gate = new ConcurrencyGate(1);
    const r1 = await gate.acquire();
    const ctl = new AbortController();
    const waiting = gate.acquire(ctl.signal);
    const next = gate.acquire();
    ctl.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(gate.queued).toBe(1);
    r1();
    await next;
    expect(gate.inFlight).toBe(1);
  });

  it("rejects at once for an already-aborted signal", async () => {
    const gate = new ConcurrencyGate(1);
    await expect(gate.acquire(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
    expect(gate.inFlight).toBe(0);
  });
});

describe("abortableSleep", () => {
  it("rejects with the abort reason mid-wait", async () => {
    const ctl = new AbortController();
    const sleeping = abortableSleep(60_000, ctl.signal);
    ctl.abort(new Error("stop"));
    await expect(sleeping).rejects.toThrow("stop");
  });
});

function response(status: number, headers: Record<string, string> = {}, body = "{}"): Response {
  return new Response(body, { status, headers });
}

function deps(responses: Response[], overrides: Partial<HostedChatFetchDeps> = {}) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? response(200));
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal | null) => undefined);
  const d: HostedChatFetchDeps = {
    fetch,
    gate: new ConcurrencyGate(2),
    policy: P,
    jitter: () => 0,
    sleep,
    ...overrides,
  };
  return { d, fetch, sleep };
}

describe("createHostedChatFetch", () => {
  it("waits Retry-After on a 429 and returns the eventual success", async () => {
    const { d, fetch, sleep } = deps([response(429, { "Retry-After": "5" }), response(200, {}, "ok")]);
    const res = await createHostedChatFetch(d)("https://cloud.test/v1/chat/completions", { method: "POST" });
    expect(await res.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
  });

  it("hands on the last 429 after three retries (four requests in all)", async () => {
    const { d, fetch, sleep } = deps([429, 429, 429, 429, 429].map((s) => response(s)));
    const res = await createHostedChatFetch(d)("u", {});
    expect(res.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000, 8_000]);
  });

  it("retries a 502 twice, and a 500 not at all", async () => {
    const bad = deps([502, 502, 502].map((s) => response(s)));
    expect((await createHostedChatFetch(bad.d)("u", {})).status).toBe(502);
    expect(bad.fetch).toHaveBeenCalledTimes(3);

    const err = deps([response(500)]);
    expect((await createHostedChatFetch(err.d)("u", {})).status).toBe(500);
    expect(err.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the caller aborts", async () => {
    const ctl = new AbortController();
    const { d, fetch } = deps([response(429, { "Retry-After": "20" })], { sleep: abortableSleep });
    const pending = createHostedChatFetch(d)("u", { signal: ctl.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    ctl.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(d.gate.inFlight).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps at most two requests in flight and holds a slot until the body is read", async () => {
    const gate = new ConcurrencyGate(2);
    let live = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return response(200, {}, "body");
    });
    const f = createHostedChatFetch({ fetch, gate, policy: P, jitter: () => 0, sleep: abortableSleep });

    const responses = await Promise.all([f("u", {}), f("u", {})]);
    const third = f("u", {});
    await new Promise((r) => setTimeout(r, 20));
    // Both earlier bodies are unread, so the third is still queued.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gate.queued).toBe(1);

    await responses[0].text();
    await (await third).text();
    await responses[1].text();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.inFlight).toBe(0);
  });

  it("releases the slot when the body is cancelled or the request fails", async () => {
    const gate = new ConcurrencyGate(1);
    const ok = createHostedChatFetch({
      fetch: async () => response(200),
      gate,
      policy: P,
      jitter: () => 0,
      sleep: abortableSleep,
    });
    await (await ok("u", {})).body?.cancel();
    expect(gate.inFlight).toBe(0);

    const failing = createHostedChatFetch({
      fetch: async () => Promise.reject(new TypeError("Failed to fetch")),
      gate,
      policy: P,
      jitter: () => 0,
      sleep: abortableSleep,
    });
    await expect(failing("u", {})).rejects.toThrow("Failed to fetch");
    expect(gate.inFlight).toBe(0);
  });
});

describe("hostedChatFetch lanes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not block a realtime (polish) call while two deep analyses hold the deep gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, {}, "body")));
    // Two analyses whose (streamed) bodies are still unread: the deep lane is full.
    const analyses = await Promise.all([hostedChatFetch("deep")("u", {}), hostedChatFetch("deep")("u", {})]);
    expect(hostedChatGates.deep.inFlight).toBe(2);
    const third = hostedChatFetch("deep")("u", {});
    expect(hostedChatGates.deep.queued).toBe(1);

    const polish = await hostedChatFetch("realtime")("u", {});
    expect(await polish.text()).toBe("body");
    expect(hostedChatGates.realtime.inFlight).toBe(0);

    await analyses[0].text();
    await (await third).text();
    await analyses[1].text();
    expect(hostedChatGates.deep.inFlight).toBe(0);
  });

  it("lets a realtime caller's deadline cut a long Retry-After wait short", async () => {
    const fetch = vi.fn(async () => response(429, { "Retry-After": "25" }));
    vi.stubGlobal("fetch", fetch);
    const ctl = new AbortController();
    const started = Date.now();
    const pending = hostedChatFetch("realtime")("u", { signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("polish deadline")), 20);
    await expect(pending).rejects.toThrow("polish deadline");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hostedChatGates.realtime.inFlight).toBe(0);
  });
});
