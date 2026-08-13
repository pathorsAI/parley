//! Lifecycle for the floating voice-typing overlay window: a transparent,
//! always-on-top, non-focusing panel pinned to the bottom-centre of the display
//! the mouse pointer sits on. Created once (hidden) and shown/repositioned per
//! dictation.

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

/** The bits of Tauri's `Monitor` the geometry needs (physical px + scale). */
export type MonitorGeometry = {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
};

/**
 * Bottom-centre of `mon` for the WIDTH×HEIGHT (logical px) overlay, returned in
 * PHYSICAL px.
 *
 * Physical rather than logical because Tauri converts a logical position using
 * the window's CURRENT scale factor — which is still the old display's while
 * the overlay is being moved onto another one. On a mixed-DPI setup (Retina +
 * external 1x) that lands it at double/half the intended offset. Monitor
 * geometry is already physical, so doing the whole calculation there sidesteps
 * the conversion.
 */
export function bottomCenterPhysical(mon: MonitorGeometry): { x: number; y: number } {
  const scale = mon.scaleFactor || 1;
  return {
    x: Math.round(mon.position.x + (mon.size.width - WIDTH * scale) / 2),
    y: Math.round(mon.position.y + mon.size.height - (HEIGHT + BOTTOM_MARGIN) * scale),
  };
}

/**
 * The monitor whose PHYSICAL bounds contain the physical point `(x, y)`, or
 * null when the point sits in no display's rectangle.
 *
 * We do this hit-test ourselves rather than calling Tauri's `monitorFromPoint`
 * because the two APIs speak different coordinate spaces: `cursorPosition()`
 * returns a PhysicalPosition, while `monitorFromPoint` bottoms out in
 * `CGDisplayBounds`, which is LOGICAL points. On any Retina display the
 * physical cursor position is roughly double the logical one, so it lands
 * outside every display's logical rectangle and the lookup returns null —
 * silently dropping the overlay onto the fallback (main-window) display for
 * the whole bottom-right ~3/4 of the screen. `availableMonitors()` reports
 * physical geometry, so comparing there needs no unit conversion at all.
 *
 * Exported for tests.
 */
export function monitorContaining<T extends MonitorGeometry>(
  monitors: T[],
  x: number,
  y: number,
): T | null {
  return (
    monitors.find(
      (m) =>
        x >= m.position.x &&
        x < m.position.x + m.size.width &&
        y >= m.position.y &&
        y < m.position.y + m.size.height,
    ) ?? null
  );
}

/**
 * The display the mouse pointer is on. That — not `currentMonitor()`, which
 * reports where the MAIN WINDOW happens to live — is the screen the user is
 * looking at when they start dictating. Resolved once per dictation (see
 * showOverlay), so moving the mouse mid-sentence leaves the overlay put.
 *
 * Falls back to the old main-window/primary display when the pointer can't be
 * located: a misplaced overlay still beats no overlay.
 */
async function overlayMonitor(): Promise<MonitorGeometry | null> {
  const { currentMonitor, primaryMonitor, availableMonitors, cursorPosition } = await import(
    "@tauri-apps/api/window"
  );
  try {
    const cursor = await cursorPosition();
    const mon = monitorContaining(await availableMonitors(), cursor.x, cursor.y);
    if (mon) return mon;
    log.warn("voice-typing: no monitor under cursor", { x: cursor.x, y: cursor.y });
  } catch (error) {
    log.warn("voice-typing: cursor monitor lookup failed", { error: String(error) });
  }
  return (await currentMonitor()) ?? (await primaryMonitor());
}

/** Place the overlay at the bottom-centre of the monitor under the cursor. */
async function positionBottomCenter(
  win: import("@tauri-apps/api/webviewWindow").WebviewWindow,
): Promise<void> {
  const { PhysicalPosition } = await import("@tauri-apps/api/window");
  const mon = await overlayMonitor();
  if (!mon) return;
  const { x, y } = bottomCenterPhysical(mon);
  await win.setPosition(new PhysicalPosition(x, y));
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
  await invoke("present_voice_overlay").catch((error) =>
    log.warn("voice-typing: present overlay failed", { error: String(error) }),
  );
}

/** Hide the overlay (kept around for the next dictation). */
export async function hideOverlay(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("dismiss_voice_overlay").catch((error) =>
    log.warn("voice-typing: dismiss overlay failed", { error: String(error) }),
  );
}
