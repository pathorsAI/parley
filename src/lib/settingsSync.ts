import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import { log } from "./log";
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
  log.info("settings: open window", { existing: !!existing });
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
  win.once("tauri://error", (e) => log.error("settings: window error", { error: String(e) }));
}

/** Broadcast updated settings so the main window can apply them live. */
export async function broadcastSettings(settings: Settings): Promise<void> {
  if (!isTauri()) return;
  await emit(SETTINGS_EVENT, settings);
}

/** localStorage key zustand persists settings under (see store `persist` name). */
const PERSIST_KEY = "parley-settings";

/** Pull settings out of a zustand-persist localStorage payload, if present. */
function settingsFromPersist(raw: string | null): Settings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: { settings?: Settings } };
    return parsed?.state?.settings ?? null;
  } catch {
    return null;
  }
}

/**
 * Main-window listener: apply settings pushed from the settings window. Uses two
 * channels for resilience:
 *  1. A Tauri `settings://updated` event — instant, but a single listener that
 *     can be torn down by HMR/StrictMode during dev.
 *  2. The native `storage` event — fires in THIS window whenever the settings
 *     window writes the shared localStorage (both windows are same-origin). This
 *     survives listener teardown and window reloads, so settings stay in sync
 *     even if the Tauri listener is briefly gone.
 */
export async function listenForSettings(): Promise<UnlistenFn> {
  // Channel 2: cross-window localStorage updates. Available in plain browser dev
  // and under Tauri (settings + main windows share the same origin/localStorage).
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PERSIST_KEY) return;
    const settings = settingsFromPersist(e.newValue);
    if (settings) {
      log.info("settings: applied (storage event)", {
        provider: settings.provider,
        language: settings.language,
        transcriptionProvider: settings.transcriptionProvider,
      });
      useStore.getState().applySettings(settings);
    }
  };
  window.addEventListener("storage", onStorage);

  if (!isTauri()) return () => window.removeEventListener("storage", onStorage);

  // Channel 1: the Tauri broadcast (fast path).
  const unlisten = await listen<Settings>(SETTINGS_EVENT, (e) => {
    log.info("settings: applied (tauri event)", {
      provider: e.payload.provider,
      language: e.payload.language,
    });
    useStore.getState().applySettings(e.payload);
  });
  return () => {
    window.removeEventListener("storage", onStorage);
    unlisten();
  };
}
