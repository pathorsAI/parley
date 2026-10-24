import { describe, expect, it, vi } from "vitest";
import { PendingSaves } from "./pendingSaves";

describe("PendingSaves", () => {
  it("only waits for meetings the backend actually recorded", () => {
    const p = new PendingSaves<string>();
    p.capture("never-started", "snap");
    expect(p.hasPending()).toBe(false);
    p.markRecording("m1");
    p.capture("m1", "snap-1");
    expect(p.hasPending()).toBe(true);
    expect(p.snapshotOf("m1")).toBe("snap-1");
    p.settle("m1");
    expect(p.hasPending()).toBe(false);
    expect(p.snapshotOf("m1")).toBeNull();
  });

  it("a cancelled meeting leaves nothing to wait for", () => {
    const p = new PendingSaves<string>();
    p.markRecording("m1");
    p.forget("m1");
    p.capture("m1", "snap");
    expect(p.hasPending()).toBe(false);
  });

  it("keeps the Stop-time snapshot over a later guess", () => {
    const p = new PendingSaves<string>();
    p.markRecording("m1");
    p.capture("m1", "at-stop");
    p.expect("m1", "orphan");
    expect(p.snapshotOf("m1")).toBe("at-stop");
  });

  it("resolves when everything pending settles, or gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const p = new PendingSaves<string>();
      p.expect("a", null);
      p.expect("b", null);
      const done = p.whenSettled(30_000);
      p.settle("a");
      p.settle("b");
      expect(await done).toBe(true);

      p.expect("c", null);
      const late = p.whenSettled(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await late).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
