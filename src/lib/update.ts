import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./tauriEvents";
import { useStore } from "./store";
import { log } from "./log";

/**
 * In-app auto-updater. Checks the GitHub releases endpoint (see
 * tauri.conf.json `plugins.updater`) for a newer SIGNED build, surfaces it as a
 * dismissible banner, and — only on the user's click — downloads, verifies,
 * installs, and relaunches. Never updates mid-meeting on its own.
 */

// The live Update handle (carries downloadAndInstall); not serializable, so it
// lives here rather than in the store, which only holds the display info.
let pending: Update | null = null;

/**
 * Check for an update. On a hit, stash the handle and publish `{version, body}`
 * to the store so the banner shows. `silent` quiets the "up to date" log for the
 * automatic launch check (vs. the manual Settings button). No-op outside Tauri.
 */
export async function checkForUpdate(opts?: { silent?: boolean }): Promise<{ version: string; body: string } | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      pending = update;
      const info = { version: update.version, body: update.body ?? "" };
      useStore.getState().setUpdate(info);
      log.info("update: available", { version: update.version });
      return info;
    }
    useStore.getState().setUpdate(null);
    if (!opts?.silent) log.info("update: up to date");
    return null;
  } catch (e) {
    // Network down / no release / endpoint hiccup — non-fatal, just don't prompt.
    log.warn("update: check failed", { error: String(e) });
    return null;
  }
}

/**
 * Download + verify + install the pending update, then relaunch into it.
 * `onProgress` reports 0–100. Throws on failure (caller resets its busy state);
 * on success the process relaunches and this never returns.
 */
export async function applyPendingUpdate(onProgress?: (pct: number) => void): Promise<void> {
  if (!pending) return;
  let total = 0;
  let got = 0;
  await pending.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      got += e.data.chunkLength;
      if (total > 0) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
