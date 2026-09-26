// Shared localStorage JSON-cache helpers. Callers own their key namespace
// (e.g. "parley:analysis:", "parley:study-cache:"); these own the try/parse
// boilerplate so quota- and serialization-error handling lives in one place.
// Caching is best-effort by design — every failure degrades to "no cache".

/** The analysis results (see analysis/engine.ts). */
export const ANALYSIS_CACHE_PREFIX = "parley:analysis:";
/** Generated study outputs for read-only org recordings (see history/studyCache.ts). */
export const STUDY_CACHE_PREFIX = "parley:study-cache:";
/** Speaker names assigned after diarization (see speakers/namesCache.ts). */
export const SPEAKER_NAMES_CACHE_PREFIX = "parley:speakers:";

export function readJsonCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJsonCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota/serialization — best-effort */
  }
}

/** Remove every entry under `prefix`; returns how many were removed. */
export function clearCacheByPrefix(prefix: string): number {
  let removed = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) {
        localStorage.removeItem(k);
        removed++;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * Approximate bytes held under any of `prefixes`, for display (Settings ›
 * Caches). Counts key + value as UTF-16 code units × 2, which is how browsers
 * account localStorage against its quota. Best-effort: 0 when storage is
 * unavailable.
 */
export function cacheBytesByPrefix(...prefixes: string[]): number {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && prefixes.some((p) => k.startsWith(p))) {
        bytes += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2;
      }
    }
  } catch {
    /* ignore */
  }
  return bytes;
}

/** A byte count for display: "0 B", "512 B", "1.5 KB", "12 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 ("1.5 KB"), none above ("12 MB") — and never on bytes.
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
