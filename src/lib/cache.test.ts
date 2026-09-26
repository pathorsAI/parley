import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_CACHE_PREFIX,
  SPEAKER_NAMES_CACHE_PREFIX,
  STUDY_CACHE_PREFIX,
  cacheBytesByPrefix,
  clearCacheByPrefix,
  formatBytes,
} from "./cache";

/** Minimal in-memory Storage: the unit suite runs in plain Node. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("cacheBytesByPrefix", () => {
  const original = globalThis.localStorage;
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
  });

  it("counts key and value of matching entries as UTF-16 bytes", () => {
    localStorage.setItem(`${ANALYSIS_CACHE_PREFIX}a`, "12345");
    localStorage.setItem(`${STUDY_CACHE_PREFIX}b`, "xy");
    localStorage.setItem("parley:settings", "not a cache");

    const analysisKey = `${ANALYSIS_CACHE_PREFIX}a`.length + 5;
    const studyKey = `${STUDY_CACHE_PREFIX}b`.length + 2;
    expect(cacheBytesByPrefix(ANALYSIS_CACHE_PREFIX)).toBe(analysisKey * 2);
    expect(cacheBytesByPrefix(ANALYSIS_CACHE_PREFIX, STUDY_CACHE_PREFIX)).toBe((analysisKey + studyKey) * 2);
    expect(cacheBytesByPrefix(SPEAKER_NAMES_CACHE_PREFIX)).toBe(0);
  });

  it("drops to zero once the prefix is cleared", () => {
    localStorage.setItem(`${SPEAKER_NAMES_CACHE_PREFIX}x`, "names");
    expect(clearCacheByPrefix(SPEAKER_NAMES_CACHE_PREFIX)).toBe(1);
    expect(cacheBytesByPrefix(SPEAKER_NAMES_CACHE_PREFIX)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("picks a unit and keeps one decimal only for small values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });
});
