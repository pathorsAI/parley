import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./tauriEvents";
import { log } from "./log";

/** Emitted by the native "Translate → Live Translation" menu item (see menu.rs). */
const LIVE_TRANSLATE_MENU = "menu://live-translate";

/**
 * Open (or focus) the Live Translation window. It loads the same bundle at the
 * `#live-translate` hash, which main.tsx routes to <LiveTranslateApp/>. Falls
 * back to a hash navigation when not under Tauri (plain browser dev), mirroring
 * the Settings / Field Log windows.
 */
export async function openLiveTranslateWindow(): Promise<void> {
  if (!isTauri()) {
    window.location.hash = "live-translate";
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("live-translate");
  if (existing) {
    await existing.setFocus();
    return;
  }
  log.info("live-translate: open window");
  const win = new WebviewWindow("live-translate", {
    url: "index.html#live-translate",
    title: "Parley — Live Translation",
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 480,
    resizable: true,
  });
  win.once("tauri://error", (e) =>
    log.error("live-translate: window error", { error: String(e) })
  );
}

/**
 * Main-window listener: the native "Translate → Live Translation" menu opens or
 * focuses the Live Translation window. No-op outside Tauri.
 */
export async function listenForLiveTranslateMenu(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen(LIVE_TRANSLATE_MENU, () => void openLiveTranslateWindow());
}
