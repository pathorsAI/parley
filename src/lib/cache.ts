// Shared localStorage JSON-cache helpers. Callers own their key namespace
// (e.g. "parley:analysis:", "parley:study-cache:"); these own the try/parse
// boilerplate so quota- and serialization-error handling lives in one place.
// Caching is best-effort by design — every failure degrades to "no cache".

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
      if (k && k.startsWith(prefix)) {
        localStorage.removeItem(k);
        removed++;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}
