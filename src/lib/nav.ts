import { useStore } from "./store";
import { openSettingsWindow } from "./settingsSync";
import { log } from "./log";

/**
 * Where "go somewhere else in the app" is decided — one module, so a call site
 * never has to know whether a destination is a route in this window or its own
 * OS window.
 *
 * The main window navigates in place (issue #195: the recordings library and
 * Settings stopped being separate windows, so the company tree and the folder
 * tree are one tree). A SECONDARY window has no shell to navigate into, so it
 * still opens the standalone Settings window.
 */

/** True in the main window. Reads the marker main.tsx stamps on <html> when it
 *  routes the bundle, so this can't drift from that routing table. */
function inMainWindow(): boolean {
  return document.documentElement.dataset.appWindow !== undefined
    ? document.documentElement.dataset.appWindow === "main"
    : !window.location.hash.replace(/^#/, "");
}

/** Open Settings — a route in the main window, a window everywhere else. */
export function openSettings(): void {
  if (inMainWindow()) {
    useStore.getState().openSettings();
    return;
  }
  openSettingsWindow().catch((error) =>
    log.error("settings: open window failed", { error: String(error) })
  );
}
