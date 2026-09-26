// The Windows notification-area (tray) icon, frontend side. The icon itself is
// built in Rust (src-tauri/src/tray.rs); this module owns the parts that need
// the webview: its translated menu labels, and the one-time notice the first
// time the close button hides the window into it.
//
// Windows only. macOS keeps its Dock (the close button hides the window there
// too, and a Dock click brings it back), so nothing here runs on a Mac.

import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n/messages";
import type { AppLanguage } from "./types";
import { isTauri, isWindows } from "./platform";
import { useStore } from "./store";
import { log } from "./log";

/** Rust → main window: the tray's Quit item was clicked. */
export const TRAY_QUIT_EVENT = "app://quit-requested";

/** Rust → voice-typing host: the tray's Start/Stop voice typing item. */
export const TRAY_VOICE_TOGGLE_EVENT = "voicetyping://toggle";

/** localStorage flag: the "Parley is still running" notice has been shown. */
const NOTICE_SHOWN_KEY = "parley:tray-notice-shown";

/** The tray menu's labels in `language` (the payload of `set_tray_labels`). */
export function trayLabels(language: AppLanguage) {
  return {
    open: translate(language, "tray.open"),
    startVoiceTyping: translate(language, "tray.startVoiceTyping"),
    stopVoiceTyping: translate(language, "tray.stopVoiceTyping"),
    quit: translate(language, "tray.quit"),
  };
}

/** Relabel the tray menu in the app's language. No-op off Windows. */
export function syncTrayLabels(language: AppLanguage): void {
  if (!isTauri() || !isWindows()) return;
  invoke("set_tray_labels", { labels: trayLabels(language) }).catch((error) =>
    log.warn("tray: relabel failed", { error: String(error) }),
  );
}

/**
 * Whether the tray icon exists, i.e. whether hiding the main window leaves the
 * user a way back. False (and so: quit instead) when the icon failed to build
 * or the question itself failed.
 */
export async function trayActive(): Promise<boolean> {
  try {
    return await invoke<boolean>("tray_active");
  } catch (error) {
    log.warn("tray: status check failed", { error: String(error) });
    return false;
  }
}

/**
 * Explain, once per install, where the window went. Shown BEFORE the window
 * hides — as a native dialog, because an in-app toast would be hidden along
 * with the window it lives in — and resolves when the user dismisses it.
 */
export async function showTrayNoticeOnce(): Promise<void> {
  try {
    if (localStorage.getItem(NOTICE_SHOWN_KEY)) return;
    localStorage.setItem(NOTICE_SHOWN_KEY, "1");
  } catch {
    // No storage: skip the notice rather than repeat it on every close.
    return;
  }
  const { language } = useStore.getState().settings;
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(translate(language, "tray.hiddenNotice.body"), {
      title: translate(language, "tray.hiddenNotice.title"),
      kind: "info",
    });
  } catch (error) {
    log.warn("tray: hidden-window notice failed", { error: String(error) });
  }
}
