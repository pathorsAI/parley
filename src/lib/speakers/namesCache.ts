// Per-recording cache of the speaker NAMES you assign after voice diarization.
//
// The cluster assignments are already cached on disk by Rust, so re-uploading the
// same recording re-diarizes for free — but the human labels (who is "Speaker 1")
// were thrown away every run, forcing a re-type. We persist them here, keyed by
// the recording's file path + the speaker count, so a re-upload restores the
// fully-named session (which in turn lets the analysis cache hit, since its key
// includes the names). Lives in localStorage, like the analysis cache.

import { isTauri } from "../tauriEvents";

const PREFIX = "parley:speakers:";

/** Deterministic 32-bit FNV-1a hash → hex (same as the analysis cache). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const char of s) {
    h ^= char.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Cache key for a recording's speaker names. The audio path identifies the file;
 * the speaker count guards against a re-diarization with a different number of
 * speakers (whose cluster numbering wouldn't match the saved labels).
 */
function cacheKey(audioPath: string, speakerCount: number): string {
  return PREFIX + fnv1a(`${audioPath}|${speakerCount}`);
}

/** Distinct speaker count among the spoken segments — the cache-key component. */
export function speakerCountOf(segments: { speaker: number; text: string }[]): number {
  const set = new Set<number>();
  for (const s of segments) if (s.text.trim()) set.add(s.speaker);
  return set.size;
}

export function readSpeakerNames(audioPath: string, speakerCount: number): Record<string, string> | null {
  if (!audioPath || speakerCount <= 0) return null;
  try {
    const raw = localStorage.getItem(cacheKey(audioPath, speakerCount));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, string>;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

export function writeSpeakerNames(
  audioPath: string,
  speakerCount: number,
  names: Record<string, string>
): void {
  if (!audioPath || speakerCount <= 0) return;
  try {
    const key = cacheKey(audioPath, speakerCount);
    // An all-empty map is the default — don't persist it (and drop a stale entry).
    if (!Object.values(names).some((n) => n?.trim())) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(names));
  } catch {
    /* quota/serialization — caching is best-effort */
  }
}

/** Drop every cached speaker-name set (all `parley:speakers:*` entries). */
export function clearSpeakerNamesCache(): number {
  let removed = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
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
 * Listen for the native "Clear Cache → Diarization" menu action (Rust emits
 * `cache://clear-speakers` alongside wiping the on-disk cluster cache) and drop
 * the saved names too. No-op outside Tauri. Returns an unlisten function.
 */
export async function listenForSpeakerCacheClear(): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("cache://clear-speakers", () => {
    const n = clearSpeakerNamesCache();
    console.info(`[cache] cleared ${n} cached speaker-name sets`);
  });
}
