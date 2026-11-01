import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { emitEvent } from "../ipc/events";
import type { Location } from "./location";

/**
 * The other direction of SETTINGS_NAVIGATE_EVENT (settingsSync): a secondary
 * window asking the MAIN window to go somewhere — Settings › 詞庫's 前往語境庫.
 * The payload is a {@link Location}, so the main window replays it through
 * navigateTo exactly as ⌘K or back/forward would (and refuses the same way
 * during a meeting). Its listener is listenForMainNavigate in ./navigate.ts,
 * which this module deliberately doesn't import: it would pull the store's
 * whole navigation (history loading and all) into the Settings window.
 */
export const MAIN_NAVIGATE_EVENT = "main://navigate";

/** Bring the main window forward and send it to `location`. A no-op outside
 *  the Tauri shell, where there is no second window to send it to. */
export async function openInMainWindow(location: Location): Promise<void> {
  if (!isTauri()) {
    log.info("nav: main-window navigation needs the desktop app", { location });
    return;
  }
  await emitEvent<Location>(MAIN_NAVIGATE_EVENT, location);
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const main = await WebviewWindow.getByLabel("main");
    if (!main) return;
    // Closed to the tray or minimized still counts as "there": bring it back.
    await main.show();
    await main.unminimize();
    await main.setFocus();
  } catch (error) {
    log.warn("nav: focus main window failed", { error: String(error) });
  }
}
