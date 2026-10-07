import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeadline, DeadlineError, rejectOnAbort } from "./deadline";
import { isTimeoutError } from "./errors";

// The deadline is what turns a model call that never answers into an error the
// study stage can show and retry, instead of "generating" forever.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createDeadline", () => {
  it("aborts on the hard deadline with a timeout error", () => {
    const d = createDeadline({ hardMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(d.signal.aborted).toBe(false);
    expect(d.reason()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(d.signal.aborted).toBe(true);
    expect(d.reason()).toBe("hard");
    expect(d.signal.reason).toBeInstanceOf(DeadlineError);
    expect(String(d.signal.reason.message)).toContain("timed out");
    expect(isTimeoutError(d.signal.reason)).toBe(true);
  });

  it("aborts when nothing touches it for the stall window", () => {
    const d = createDeadline({ hardMs: 10_000, stallMs: 100 });
    vi.advanceTimersByTime(100);
    expect(d.reason()).toBe("stall");
    expect(d.signal.reason.message).toContain("timed out");
  });

  it("touch() keeps a stream that is still arriving alive, up to the hard ceiling", () => {
    const d = createDeadline({ hardMs: 1000, stallMs: 100 });
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(90);
      d.touch();
    }
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(10);
    // 990 + 10 = 1000 ms: the hard ceiling wins even though it was just touched.
    expect(d.reason()).toBe("hard");
  });

  it("follows a parent signal and reports it as a cancellation", () => {
    const parent = new AbortController();
    const d = createDeadline({ hardMs: 1000, stallMs: 100, parent: parent.signal });
    parent.abort(new Error("cancelled"));
    expect(d.signal.aborted).toBe(true);
    expect(d.reason()).toBe("parent");
    // The timers are gone: a later timeout must not relabel the cause.
    vi.advanceTimersByTime(5000);
    expect(d.reason()).toBe("parent");
  });

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController();
    parent.abort();
    const d = createDeadline({ hardMs: 1000, parent: parent.signal });
    expect(d.signal.aborted).toBe(true);
    expect(d.reason()).toBe("parent");
  });

  it("clear() stops every timer", () => {
    const d = createDeadline({ hardMs: 100, stallMs: 50 });
    d.clear();
    vi.advanceTimersByTime(1000);
    expect(d.signal.aborted).toBe(false);
    expect(d.reason()).toBeNull();
  });
});

describe("rejectOnAbort", () => {
  it("rejects with the abort reason", async () => {
    const d = createDeadline({ hardMs: 10 });
    const p = rejectOnAbort(d.signal);
    vi.advanceTimersByTime(10);
    await expect(p).rejects.toBeInstanceOf(DeadlineError);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const c = new AbortController();
    c.abort(new Error("gone"));
    await expect(rejectOnAbort(c.signal)).rejects.toThrow("gone");
  });
});
