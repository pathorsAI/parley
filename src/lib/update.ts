import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { isTauri } from "./tauriEvents";
import { useStore } from "./store";
import { translate, type TranslationKey } from "../i18n/messages";
import { log } from "./log";

/**
 * In-app auto-updater. Checks the GitHub releases endpoint (see
 * tauri.conf.json `plugins.updater`) for a newer SIGNED build and surfaces it as
 * a Sonner toast with an "update & restart" action — only on the user's click
 * does it download, verify, install, and relaunch. Never updates mid-meeting.
 *
 * NOTE: `check` and `relaunch` are imported STATICALLY (not dynamically). A
 * dynamic import of `relaunch` AFTER downloadAndInstall would try to fetch its JS
 * chunk from the app bundle that the install just replaced on disk — the import
 * then rejects and the app never restarts. Loading both at startup avoids
 * touching the swapped bundle. They're side-effect-free in the browser (guarded
 * by isTauri before any call), so this is safe in plain web dev too.
 */

const TOAST_ID = "app-update";

// The live Update handle (carries downloadAndInstall); not serializable.
let pending: Update | null = null;

/** Translate with the current UI language (this module isn't a React component). */
function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(useStore.getState().settings.language, key, vars);
}

/**
 * Check for an update. On a hit, prompt with a persistent toast carrying the
 * "update & restart" action. `silent` quiets the "up to date" log for the
 * automatic launch check (vs. the manual Settings button). No-op outside Tauri.
 */
export async function checkForUpdate(opts?: { silent?: boolean }): Promise<{ version: string; body: string } | null> {
  if (!isTauri()) return null;
  try {
    const update = await check();
    if (update) {
      pending = update;
      log.info("update: available", { version: update.version });
      toast(t("update.available", { version: update.version }), {
        id: TOAST_ID,
        duration: Infinity,
        action: { label: t("update.restart"), onClick: () => void runUpdate() },
      });
      return { version: update.version, body: update.body ?? "" };
    }
    if (!opts?.silent) log.info("update: up to date");
    return null;
  } catch (e) {
    // Network down / no release / endpoint hiccup — non-fatal, just don't prompt.
    log.warn("update: check failed", { error: String(e) });
    return null;
  }
}

/** Download + verify + install the pending update (with progress), then relaunch. */
async function runUpdate(): Promise<void> {
  if (!pending) return;
  let total = 0;
  let got = 0;
  log.info("update: downloading + installing", { version: pending.version });
  try {
    toast.loading(t("update.updating"), { id: TOAST_ID, duration: Infinity });
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        if (total > 0) {
          const pct = Math.min(100, Math.round((got / total) * 100));
          toast.loading(t("update.downloadingPct", { pct }), { id: TOAST_ID, duration: Infinity });
        }
      } else if (e.event === "Finished") {
        log.info("update: download finished, installed");
      }
    });
    log.info("update: relaunching into the new version");
    await relaunch(); // never returns on success
  } catch (e) {
    // Install finished but the auto-relaunch failed (e.g. App Translocation) —
    // the new version IS staged, so tell the user to reopen rather than fail silently.
    log.warn("update: relaunch failed", { error: String(e) });
    toast.error(t("update.reopen"), { id: TOAST_ID, duration: Infinity });
  }
}
