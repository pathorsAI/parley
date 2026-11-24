import { describe, expect, it } from "vitest";

import { HOSTED_MAX_PART_SECONDS, HOSTED_UPLOAD_LIMIT_BYTES } from "../limits";
import {
  decideImport,
  formatLongDuration,
  partTitle,
  splitPlan,
  wizardGate,
} from "./split";

const H = 3600;

describe("splitPlan", () => {
  it("leaves a recording that fits one upload alone", () => {
    expect(splitPlan(2 * H)).toBeNull();
    expect(splitPlan(6 * H - 11 * 60)).toBeNull();
  });

  it("does not split at exactly 5 h 50 min, and does one second over", () => {
    expect(HOSTED_MAX_PART_SECONDS).toBe(5 * H + 50 * 60);
    expect(splitPlan(HOSTED_MAX_PART_SECONDS)).toBeNull();
    expect(splitPlan(HOSTED_MAX_PART_SECONDS + 1)).toEqual({
      parts: 2,
      partSeconds: (HOSTED_MAX_PART_SECONDS + 1) / 2,
    });
  });

  it("splits into ceil(duration / 5h50m) EQUAL parts", () => {
    expect(splitPlan(6 * H)).toEqual({ parts: 2, partSeconds: 3 * H });
    expect(splitPlan(12 * H)).toEqual({ parts: 3, partSeconds: 4 * H });
    const plan = splitPlan(20 * H + 7)!;
    expect(plan.parts).toBe(4);
    expect(plan.partSeconds * plan.parts).toBeCloseTo(20 * H + 7);
    expect(plan.partSeconds).toBeLessThanOrEqual(HOSTED_MAX_PART_SECONDS);
  });

  it("does nothing for an unknown duration", () => {
    expect(splitPlan(null)).toBeNull();
    expect(splitPlan(undefined)).toBeNull();
    expect(splitPlan(Number.NaN)).toBeNull();
  });
});

describe("decideImport", () => {
  const probe = (durationMs: number | null, compressible = true, bytes = 10_000_000) => ({
    durationMs,
    compressible,
    bytes,
  });

  it("splits a long hosted upload", () => {
    expect(decideImport(probe(7 * H * 1000), true)).toEqual({
      kind: "split",
      durationSeconds: 7 * H,
      plan: { parts: 2, partSeconds: 3.5 * H },
    });
  });

  it("never splits for BYOK vendors", () => {
    expect(decideImport(probe(7 * H * 1000), false)).toEqual({ kind: "proceed" });
  });

  it("proceeds when the duration is unknown or the probe failed", () => {
    expect(decideImport(probe(null), true)).toEqual({ kind: "proceed" });
    expect(decideImport(null, true)).toEqual({ kind: "proceed" });
  });

  it("refuses an uncompressible hosted file over the upload limit up front", () => {
    expect(decideImport(probe(null, false, HOSTED_UPLOAD_LIMIT_BYTES + 1), true)).toEqual({
      kind: "refuse",
      key: "ingest.error.uncompressibleTooLarge",
    });
    expect(decideImport(probe(null, false, HOSTED_UPLOAD_LIMIT_BYTES), true)).toEqual({ kind: "proceed" });
    expect(decideImport(probe(null, false, HOSTED_UPLOAD_LIMIT_BYTES + 1), false)).toEqual({
      kind: "proceed",
    });
  });
});

describe("wizardGate", () => {
  it("waits for the probe, then shows the refusal, the notice, or the form", () => {
    expect(wizardGate(null, false)).toBe("probing");
    expect(wizardGate({ kind: "refuse", key: "ingest.error.uncompressibleTooLarge" }, false)).toBe("refuse");
    const split = decideImport({ durationMs: 8 * H * 1000, compressible: true, bytes: 1 }, true);
    expect(wizardGate(split, false)).toBe("splitNotice");
    expect(wizardGate(split, true)).toBe("ready");
    expect(wizardGate({ kind: "proceed" }, false)).toBe("ready");
  });
});

describe("formatting", () => {
  it("formats long durations in hours and minutes", () => {
    expect(formatLongDuration(7 * H + 12 * 60, "zh-TW")).toBe("7 小時 12 分");
    expect(formatLongDuration(7 * H + 12 * 60, "en")).toBe("7 h 12 min");
    expect(formatLongDuration(3 * H, "zh-TW")).toBe("3 小時");
    expect(formatLongDuration(45 * 60 + 20, "en")).toBe("45 min");
  });

  it("titles each part after the file", () => {
    expect(partTitle("董事會.mp3", 1, 3, "zh-TW")).toBe("董事會.mp3（1/3）");
    expect(partTitle("board.mp3", 2, 3, "en")).toBe("board.mp3 (2/3)");
  });
});
