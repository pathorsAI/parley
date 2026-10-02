import { describe, expect, it } from "vitest";
import {
  CLOSE_WAIT_MAX_MS,
  QUIET_FLOOR_MS,
  SETTLE_MS,
  settleVerdict,
  type SettleInput,
} from "./settle";

const RELEASE = 100_000;

/** A released, still-open session at `release + after` ms. */
function at(after: number, over: Partial<SettleInput> = {}): SettleInput {
  return {
    now: RELEASE + after,
    releasedAt: RELEASE,
    closedAt: 0,
    failed: false,
    lastSegmentAt: 0,
    tailPending: false,
    ...over,
  };
}

describe("settleVerdict", () => {
  /** The regression for "a short tap pastes nothing": the relay had not
   *  answered by the release, and the old quiet rule delivered 60 ms later. */
  it("waits out a short tap that has no answer yet, up to the cap", () => {
    for (const after of [60, QUIET_FLOOR_MS, CLOSE_WAIT_MAX_MS - 1]) {
      expect(settleVerdict(at(after))).toEqual({ waitMs: CLOSE_WAIT_MAX_MS - after });
    }
    expect(settleVerdict(at(CLOSE_WAIT_MAX_MS))).toEqual({ finalize: "timeout" });
  });

  it("never counts silence that began before the release", () => {
    const v = settleVerdict(at(600, { lastSegmentAt: RELEASE - 800 }));
    expect("waitMs" in v).toBe(true);
  });

  it("delivers on the close, whatever the quiet or the tail say", () => {
    expect(settleVerdict(at(5, { closedAt: RELEASE + 5, tailPending: true }))).toEqual({
      finalize: "closed",
    });
    // A close remembered from before the release still counts.
    expect(settleVerdict(at(5, { closedAt: RELEASE - 50 }))).toEqual({ finalize: "closed" });
  });

  it("delivers a failed session at once", () => {
    expect(settleVerdict(at(0, { failed: true, tailPending: true }))).toEqual({
      finalize: "failed",
    });
  });

  /** The regression for "the last words are cut off": an answer after the
   *  release no longer ends the dictation 500 ms later — the finalize's own
   *  answer gets until the floor to arrive. */
  it("after a post-release answer, waits for the floor and then for quiet", () => {
    const heard = { lastSegmentAt: RELEASE + 300 };
    expect(settleVerdict(at(900, heard))).toEqual({ waitMs: QUIET_FLOOR_MS - 900 });
    expect(settleVerdict(at(QUIET_FLOOR_MS, heard))).toEqual({ finalize: "quiet" });
    // At the floor, but the last segment is too recent: quiet is SETTLE_MS
    // after it.
    const recent = { lastSegmentAt: RELEASE + QUIET_FLOOR_MS - 100 };
    expect(settleVerdict(at(QUIET_FLOOR_MS, recent))).toEqual({ waitMs: SETTLE_MS - 100 });
    expect(settleVerdict(at(QUIET_FLOOR_MS - 100 + SETTLE_MS, recent))).toEqual({
      finalize: "quiet",
    });
  });

  it("does not call a tentative tail quiet, all the way to the cap", () => {
    const tail = { lastSegmentAt: RELEASE + 100, tailPending: true };
    expect(settleVerdict(at(QUIET_FLOOR_MS + SETTLE_MS, tail))).toEqual({
      waitMs: CLOSE_WAIT_MAX_MS - QUIET_FLOOR_MS - SETTLE_MS,
    });
    expect(settleVerdict(at(CLOSE_WAIT_MAX_MS, tail))).toEqual({ finalize: "timeout" });
  });

  it("asks to be checked again within the cap, and never in 0 ms", () => {
    const cases: Partial<SettleInput>[] = [
      {},
      { lastSegmentAt: RELEASE + 10 },
      { lastSegmentAt: RELEASE + 10, tailPending: true },
      { lastSegmentAt: RELEASE - 10 },
    ];
    for (const over of cases) {
      for (let after = 0; after < CLOSE_WAIT_MAX_MS; after += 37) {
        const v = settleVerdict(at(after, over));
        if ("finalize" in v) continue;
        expect(v.waitMs).toBeGreaterThanOrEqual(1);
        expect(after + v.waitMs).toBeLessThanOrEqual(CLOSE_WAIT_MAX_MS);
      }
    }
  });
});
