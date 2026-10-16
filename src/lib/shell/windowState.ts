// The main window's own state and controls, for the custom titlebar (the
// window is undecorated, so the app draws its traffic lights / caption buttons).

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "../platform";
import { isTauri } from "../tauriEvents";
import { log } from "../log";

/** What a window-control button asks the window to do. */
export type WindowAction = "close" | "minimize" | "fullscreen" | "maximize";

/**
 * Track main-window focus so the traffic lights can dim to grey when the window
 * is inactive — matching native macOS behaviour. Defaults to focused (and stays
 * focused in browser dev, where there's no window to query).
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    async function connectFocusEvents() {
      const win = getCurrentWindow();
      try {
        const initial = await win.isFocused();
        if (active) setFocused(initial);
      } catch {
        /* ignore — keep default */
      }
      const un = await win.onFocusChanged(({ payload }) => {
        if (active) setFocused(payload);
      });
      if (active) unlisten = un;
      else un();
    }
    connectFocusEvents().catch((error) => log.warn("window: focus listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return focused;
}

/**
 * Track whether the main window is maximized, so the Windows caption cluster
 * can offer restore instead of a second maximize.
 *
 * Driven by the window's own resize event rather than by our click handler:
 * Windows Snap, a double-click on the drag region and the system menu all
 * maximize without ever passing through the button, and a button that lied
 * about the window state would be worse than the one that never changed. Tauri
 * has no dedicated maximize event, so onResized is the signal and isMaximized()
 * is the question — the payload only carries the new size.
 *
 * macOS never renders this cluster (the traffic lights do zoom instead), so
 * there's no listener to keep alive there.
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri() || isMac()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    async function connectResizeEvents() {
      const win = getCurrentWindow();
      const read = async () => {
        try {
          const now = await win.isMaximized();
          if (active) setMaximized(now);
        } catch {
          /* ignore — keep the last known state */
        }
      };
      // Seed from the current value: the window can already be maximized when
      // this mounts (a reload, or a size restored from the last session).
      await read();
      // read() handles its own failure, so the promise it returns cannot reject.
      const un = await win.onResized(() => {
        read().catch(() => {});
      });
      if (active) unlisten = un;
      else un();
    }
    connectResizeEvents().catch((error) =>
      log.warn("window: maximize listener failed", { error: String(error) })
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return maximized;
}

/** Carry out a window-control click. A no-op outside the Tauri shell. */
export async function controlWindow(action: WindowAction) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  try {
    if (action === "close") await appWindow.close();
    if (action === "minimize") await appWindow.minimize();
    // Native macOS maps the green button to full screen (not window zoom).
    if (action === "fullscreen") await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    // Windows caption button semantics: maximize/restore, not fullscreen.
    if (action === "maximize") await appWindow.toggleMaximize();
  } catch (e) {
    log.warn("window: action failed", { action, error: String(e) });
  }
}
