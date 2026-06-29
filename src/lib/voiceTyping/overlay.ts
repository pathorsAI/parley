//! Lifecycle for the floating voice-typing overlay window: a transparent,
//! always-on-top, non-focusing panel pinned to the bottom-centre of the active
//! display. Created once (hidden) and shown/repositioned per dictation.

import { isTauri } from "../tauriEvents";
import { log } from "../log";

const LABEL = "voice-typing";
const WIDTH = 460;
const HEIGHT = 180;
/** Gap above the screen bottom (sits low, just clearing the Dock). */
const BOTTOM_MARGIN = 64;

let ensuring: Promise<void> | null = null;

/**
 * Pre-create the overlay (hidden) at startup so its webview is mounted and
 * already subscribed to the session/transcript events before the first key
 * press — otherwise the first dictation races the window load.
 */
export async function prewarmOverlay(): Promise<void> {
  await ensureOverlay();
}

/** Create the overlay window once (hidden). Idempotent. */
async function ensureOverlay(): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  if (await WebviewWindow.getByLabel(LABEL)) return;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const win = new WebviewWindow(LABEL, {
      url: "index.html#voice-typing",
      title: "Parley Voice Typing",
      width: WIDTH,
      height: HEIGHT,
      transparent: true,
      decorations: false,
      // NOTE: no `alwaysOnTop` — Tauri's implementation re-manages the window
      // level/collection-behaviour and fights our native present_voice_overlay
      // (which sets a screen-saver level + canJoinAllSpaces|fullScreenAuxiliary
      // so the overlay floats over full-screen apps).
      skipTaskbar: true,
      shadow: false,
      resizable: false,
      // Don't steal focus from the app the user is typing into.
      focus: false,
      visible: false,
    });
    await new Promise<void>((resolve) => {
      win.once("tauri://created", () => resolve());
      win.once("tauri://error", (e) => {
        log.error("voice-typing: overlay create error", { error: String(e) });
        resolve();
      });
    });
  })();
  try {
    await ensuring;
  } finally {
    ensuring = null;
  }
}

/** Place the overlay at the bottom-centre of the active monitor (logical px). */
async function positionBottomCenter(win: import("@tauri-apps/api/webviewWindow").WebviewWindow): Promise<void> {
  const { currentMonitor, primaryMonitor, LogicalPosition } = await import("@tauri-apps/api/window");
  const mon = (await currentMonitor()) ?? (await primaryMonitor());
  if (!mon) return;
  const scale = mon.scaleFactor || 1;
  const monX = mon.position.x / scale;
  const monY = mon.position.y / scale;
  const monW = mon.size.width / scale;
  const monH = mon.size.height / scale;
  const x = Math.round(monX + (monW - WIDTH) / 2);
  const y = Math.round(monY + monH - HEIGHT - BOTTOM_MARGIN);
  await win.setPosition(new LogicalPosition(x, y));
}

/** Reposition + show the overlay (creating it on first use). Shown natively via
 *  `orderFrontRegardless` so it floats above whatever app is frontmost without
 *  activating Parley or stealing keyboard focus. */
export async function showOverlay(): Promise<void> {
  if (!isTauri()) return;
  await ensureOverlay();
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel(LABEL);
  if (!win) return;
  await positionBottomCenter(win);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("present_voice_overlay").catch(() => {});
}

/** Hide the overlay (kept around for the next dictation). */
export async function hideOverlay(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("dismiss_voice_overlay").catch(() => {});
}
