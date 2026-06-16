import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import type { Settings } from "./types";

const SETTINGS_EVENT = "settings://updated";

/**
 * Open (or focus) the dedicated Settings window. It loads the same bundle at the
 * `#settings` hash, which main.tsx routes to <SettingsApp/>. Falls back to a hash
 * navigation when not running under Tauri (plain browser dev).
 */
export async function openSettingsWindow(): Promise<void> {
  if (!isTauri()) {
    window.location.hash = "settings";
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow("settings", {
    url: "index.html#settings",
    title: "Parley Settings",
    width: 880,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
  });
  win.once("tauri://error", (e) => console.error("settings window error", e));
}

/** Broadcast updated settings so the main window can apply them live. */
export async function broadcastSettings(settings: Settings): Promise<void> {
  if (!isTauri()) return;
  await emit(SETTINGS_EVENT, settings);
}

/** Main-window listener: apply settings pushed from the settings window. */
export async function listenForSettings(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<Settings>(SETTINGS_EVENT, (e) => {
    useStore.getState().applySettings(e.payload);
  });
}
