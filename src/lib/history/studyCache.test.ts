import { describe, it, expect, beforeEach, vi } from "vitest";

// The unit suite runs in a plain Node env (no DOM); back the best-effort
// localStorage cache with a Map so the merge semantics are actually exercised.
const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
});

import { readStudyCache, writeStudyCache, clearStudyCache } from "./studyCache";
import type { TimelineEvent } from "../types";

const finding: TimelineEvent = {
  id: "f1",
  atMs: 1000,
  side: "them",
  severity: "warn",
  source: "extra",
  title: "moment",
  detail: "something happened",
};

beforeEach(() => {
  clearStudyCache(); // resets the module memo AND drops the backing keys
});

describe("writeStudyCache `analyzed` merge", () => {
  it("accretes and never un-sets: a mid-pipeline false keeps an earlier true", () => {
    writeStudyCache("e1", { findings: [finding], analyzed: true });
    // A later persist while a re-run is still in flight reports false — the
    // completed marker (and the untouched outputs) must survive it.
    writeStudyCache("e1", { analyzed: false, brief: "debrief" });

    const cached = readStudyCache("e1");
    expect(cached?.analyzed).toBe(true);
    expect(cached?.findings).toEqual([finding]);
    expect(cached?.brief).toBe("debrief");
  });

  it("a plain false is dropped, not stored (absent ≙ unknown for old caches)", () => {
    writeStudyCache("e2", { analyzed: false });
    expect(readStudyCache("e2")?.analyzed).toBeUndefined();
  });
});
