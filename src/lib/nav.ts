import type { SettingsCategory } from "./store";
import { openSettingsWindow } from "./settingsSync";
import { log } from "./log";

/**
 * Where "go somewhere else in the app" is decided — one module, so a call site
 * never has to know whether a destination is a route in this window or its own
 * OS window.
 */

/** Open Settings — its own OS window, from any window. `category` deep-links a
 *  nav panel (e.g. the titlebar 🌐 menu → 翻譯). */
export function openSettings(category?: SettingsCategory): void {
  openSettingsWindow(category).catch((error) =>
    log.error("settings: open window failed", { error: String(error) })
  );
}
