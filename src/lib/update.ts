import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { isTauri } from "./tauriEvents";
import { useStore } from "./store";
import { translate, type TranslationKey } from "../i18n/messages";
import { log } from "./log";
import { rememberPendingReleaseNotes } from "./releaseNotes";

/**
 * In-app auto-updater. Checks the GitHub releases endpoint (see
 * tauri.conf.json `plugins.updater`) for a newer SIGNED build and surfaces it as
 * a Sonner toast with an "update & restart" action — only on the user's click
 * does it download, verify, install, and relaunch. Never updates mid-meeting.
 *
 * NOTE: `check`, `relaunch` and `invoke` are imported STATICALLY (not
 * dynamically). A dynamic import of `relaunch` AFTER downloadAndInstall would try
 * to fetch its JS chunk from the app bundle that the install just replaced on
 * disk — the import then rejects and the app never restarts. Loading them at
 * startup avoids touching the swapped bundle. They're side-effect-free in the
 * browser (guarded by isTauri before any call), so this is safe in plain web dev
 * too.
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
  let installed = false;
  log.info("update: downloading + installing", { version: pending.version });
  try {
    rememberPendingReleaseNotes({ version: pending.version, body: pending.body ?? "" });
    toast.loading(t("update.updating"), { id: TOAST_ID, duration: Infinity });
    // The relaunch inherits this process's argv, so a Parley started by the
    // login item would come back with `--autostart` and keep its window hidden
    // — right after the user clicked "Update & restart". This one-shot marker
    // tells the next launch to show the window anyway (src-tauri/src/autostart.rs).
    // Written BEFORE downloadAndInstall: on Windows the install exits the
    // process from inside that call, so relaunch() below never runs there.
    // Best effort — a missing marker costs a hidden window, not the update.
    await invoke("mark_show_on_next_launch").catch((error: unknown) => {
      log.warn("update: could not mark the next launch to show the window", { error: String(error) });
    });
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
    installed = true;
    log.info("update: relaunching into the new version");
    await relaunch(); // never returns on success
  } catch (e) {
    // downloadAndInstall failed, so nothing will relaunch: drop the marker
    // rather than let it surface the window at some unrelated later launch. A
    // failed relaunch() keeps it — the update is staged and the user reopens
    // by hand, which shows the window anyway.
    if (!installed) void invoke("clear_show_on_next_launch").catch(() => {});
    // Install finished but the auto-relaunch failed (e.g. App Translocation) —
    // the new version IS staged, so tell the user to reopen rather than fail silently.
    log.warn("update: relaunch failed", { error: String(e) });
    toast.error(t("update.reopen"), { id: TOAST_ID, duration: Infinity });
  }
}
