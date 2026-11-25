// The background filing queue: names saved recordings nobody has opened (the
// filing pass, filingRun.runFilingForEntry), one at a time.
//
// Two producers:
//  - a save: a live meeting or an upload, the moment it is on disk
//    (history.saveLiveToHistory / saveUploadToHistory). Fire-and-forget — the
//    save, and quitting after it, never wait for the pass.
//  - the catch-up at launch: recent recordings (the last 7 days) that were
//    never named — saved by a version without this queue, or by a run that quit
//    before its pass landed. Older history is left alone on purpose: each pass
//    is a model call, and a library of hundreds must not pay for all of them.
//
// Concurrency 1 and de-duplicated by entry id, so a meeting saved during the
// catch-up waits its turn instead of racing it, and an id queued twice runs once.

import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";
import { hasSpokenSegment } from "../replay/keepWindow";
import { runFilingForEntry } from "./filingRun";
import type { HistoryEntry } from "../history/types";
import { log } from "../log";

/** How far back the launch catch-up looks (by when a recording was made). */
export const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long after launch the catch-up starts: settings, the library and the
 *  crash recovery come first. */
const CATCH_UP_DELAY_MS = 20_000;

const pending: string[] = [];
const queued = new Set<string>();
let draining: Promise<void> | null = null;

/** Queue the background filing pass for a saved entry. A no-op for an id already
 *  queued or running. Never throws, never blocks the caller. */
export function queueBackgroundFiling(entryId: string): void {
  if (!entryId || queued.has(entryId)) return;
  queued.add(entryId);
  pending.push(entryId);
  draining ??= drain().finally(() => {
    draining = null;
  });
}

async function drain(): Promise<void> {
  for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
    try {
      await runFilingForEntry(id);
    } catch (e) {
      // runFilingForEntry handles its own failures; this is the backstop that
      // keeps one bad entry from stalling everything queued behind it.
      log.warn("filing: background pass failed", { entryId: id, error: String(e) });
    } finally {
      queued.delete(id);
    }
  }
}

/** Resolves once the queue is empty (for tests and callers that want to wait). */
export function backgroundFilingSettled(): Promise<void> {
  return draining ?? Promise.resolve();
}

/**
 * Does a saved entry still need its filing pass from the catch-up? Made in the
 * last {@link CATCH_UP_WINDOW_MS}, has speech, never answered (no flag, no
 * pending suggestion — an entry another device already filed comes down from
 * the cloud with the flag), and not a recovered recording (its （已復原） name
 * stays; the folders alone are not worth a sweep). Pure + exported for testing.
 */
export function needsCatchUp(entry: HistoryEntry, now: number): boolean {
  if (entry.createdAt < now - CATCH_UP_WINDOW_MS) return false;
  if (entry.filingSuggested || entry.filingSuggestion != null) return false;
  if (entry.recovered) return false;
  return hasSpokenSegment(entry.segments ?? []);
}

/**
 * Queue every recent, never-named local recording, oldest first. Reads only the
 * entries the summaries place inside the window. Resolves to how many it queued.
 */
export async function catchUpBackgroundFiling(now: number = Date.now()): Promise<number> {
  const s = useStore.getState();
  if (!hasProviderKey(s.settings, "realtime") || !s.settings.autoStudyAnalysis) return 0;
  const { listHistory, readEntry } = await import("../history/entryStore");
  const recent = (await listHistory())
    .filter((e) => e.createdAt >= now - CATCH_UP_WINDOW_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
  let count = 0;
  for (const summary of recent) {
    try {
      const { meta } = await readEntry(summary.id);
      if (!needsCatchUp(meta, now)) continue;
      queueBackgroundFiling(summary.id);
      count++;
    } catch (e) {
      log.warn("filing: catch-up could not read an entry", { entryId: summary.id, error: String(e) });
    }
  }
  if (count) log.info("filing: catch-up queued", { count });
  return count;
}

/** Start the launch catch-up after a short delay. Returns its cancel. */
export function scheduleFilingCatchUp(delayMs: number = CATCH_UP_DELAY_MS): () => void {
  const timer = setTimeout(() => {
    catchUpBackgroundFiling().catch((e) => log.warn("filing: catch-up failed", { error: String(e) }));
  }, delayMs);
  return () => clearTimeout(timer);
}
