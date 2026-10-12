import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import type { Settings } from "../types";

// streamObjectResilient is the call every study stage waits on. These pin down
// that it always comes back — with a result or an error — instead of leaving the
// stage "generating" forever.

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { model } = vi.hoisted(() => ({ model: { current: null as unknown } }));
vi.mock("./provider", () => ({
  getModel: () => model.current,
  getProviderOptions: () => undefined,
}));

import { streamObjectResilient } from "./generate";
import { isTimeoutError } from "./errors";
import { ONE_SHOT_DEADLINE_MS, STUDY_FIRST_OUTPUT_MS } from "./deadline";

const schema = z.object({ a: z.string() });
const settings = {
  llmProviders: { deep: "anthropic", realtime: "anthropic" },
  models: { anthropic: { deep: "claude-test", realtime: "claude-test" } },
} as unknown as Settings;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const generated = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
});

/** A stream that sends one partial and then goes silent — erroring only when
 *  its request is aborted, as a real fetch body does. */
function stallingStream(abortSignal: AbortSignal | undefined) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t" });
      controller.enqueue({ type: "text-delta", id: "t", delta: '{"a":"par' });
      abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason));
    },
  });
}

const call = (extra: Partial<Parameters<typeof streamObjectResilient>[0]> = {}) =>
  streamObjectResilient({ settings, workload: "deep", schema, system: "s", prompt: "p", ...extra });

afterEach(() => {
  model.current = null;
});

describe("streamObjectResilient", () => {
  it("returns the streamed object", async () => {
    model.current = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: '{"a":"ok"}' });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            c.close();
          },
        }),
      }),
    });
    const res = await call();
    expect(res.object).toEqual({ a: "ok" });
  });

  it("does not hang when the request fails before the stream starts", async () => {
    // The AI SDK reports such a failure only to onError and never settles
    // `object` — this used to await forever.
    model.current = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("HTTP 500 before streaming");
      },
      doGenerate: async () => generated('{"a":"fallback"}'),
    });
    const res = await call();
    expect(res.object).toEqual({ a: "fallback" });
  });

  it("gives up on a stalled stream and falls back to one non-streamed call", async () => {
    const onPartial = vi.fn();
    model.current = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({ stream: stallingStream(abortSignal) }),
      doGenerate: async () => generated('{"a":"recovered"}'),
    });
    const res = await call({ stallMs: 30, onPartial });
    expect(res.object).toEqual({ a: "recovered" });
    // The fallback's object is emitted as the final partial.
    expect(onPartial).toHaveBeenLastCalledWith({ a: "recovered" });
  });

  it("throws a timeout error when the fallback runs out of time too", async () => {
    model.current = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({ stream: stallingStream(abortSignal) }),
      // Never answers; only the deadline ends it.
      doGenerate: () => new Promise(() => {}),
    });
    vi.useFakeTimers();
    try {
      const p = call({ stallMs: 30 });
      const settled = p.then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(30);
      // The fallback gets a fresh one-shot ceiling — not a shorter one.
      await vi.advanceTimersByTimeAsync(ONE_SHOT_DEADLINE_MS - 1);
      expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      const err = await settled;
      expect(isTimeoutError(err)).toBe(true);
      expect(String((err as Error).message)).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits longer for the first partial than between later ones", async () => {
    const doGenerate = vi.fn(async () => generated('{"a":"recovered"}'));
    model.current = new MockLanguageModelV3({
      // Accepts the request, then says nothing at all (yet).
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            abortSignal?.addEventListener("abort", () => c.error(abortSignal.reason));
          },
        }),
      }),
      doGenerate,
    });
    vi.useFakeTimers();
    try {
      const p = call({ stallMs: 30 });
      // Well past the stall window: still waiting for the first output.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(doGenerate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STUDY_FIRST_OUTPUT_MS - 60_000);
      expect((await p).object).toEqual({ a: "recovered" });
      expect(doGenerate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a call its caller cancelled", async () => {
    const doGenerate = vi.fn(async () => generated('{"a":"never"}'));
    model.current = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({ stream: stallingStream(abortSignal) }),
      doGenerate,
    });
    const controller = new AbortController();
    const p = call({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await expect(p).rejects.toThrow("cancelled");
    expect(doGenerate).not.toHaveBeenCalled();
  });
});
