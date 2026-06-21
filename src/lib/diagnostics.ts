import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./tauriEvents";
import { log } from "./log";

/** Emitted by the native Diagnostics → View Logs menu item (see menu.rs). */
const VIEW_LOGS_MENU = "menu://view-logs";

/**
 * Open (or focus) the standalone Field Log window. It loads the same bundle at
 * the `#diagnostics` hash, which main.tsx routes to <DiagnosticsApp/>. Falls
 * back to a hash navigation when not running under Tauri (plain browser dev),
 * mirroring the Settings window.
 */
export async function openDiagnosticsWindow(): Promise<void> {
  if (!isTauri()) {
    window.location.hash = "diagnostics";
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("diagnostics");
  if (existing) {
    await existing.setFocus();
    return;
  }
  log.info("diagnostics: open window");
  const win = new WebviewWindow("diagnostics", {
    url: "index.html#diagnostics",
    title: "Parley — Field Log",
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 380,
    resizable: true,
  });
  win.once("tauri://error", (e) => log.error("diagnostics: window error", { error: String(e) }));
}

/**
 * Main-window listener: the native "Diagnostics → View Logs" menu opens/focuses
 * the Field Log window. No-op outside Tauri.
 */
export async function listenForViewLogsMenu(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen(VIEW_LOGS_MENU, () => void openDiagnosticsWindow());
}
