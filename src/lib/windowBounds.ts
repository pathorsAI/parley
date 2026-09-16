import { log } from "./log";
import { isTauri } from "./platform";

/**
 * Keep a secondary window inside the display it opens on.
 *
 * Tauri sizes windows in LOGICAL pixels, and a Windows desktop has far fewer of
 * those than a Mac: a 1920x1080 panel at 150% scaling is only 1280x720 logical,
 * roughly 1280x693 once the taskbar is out. The sizes the Settings, Diagnostics
 * and Finding-Solution windows ask for were all picked on a Mac, so on that
 * machine Settings opened 760 logical px tall — taller than the screen — with a
 * 520px minimum that then stopped the user dragging it back into view.
 *
 * `isTauri` comes from ./platform rather than ./tauriEvents on purpose: this
 * module is imported by settingsSync, which tauriEvents already reaches.
 */

/**
 * The slice of Tauri's `Monitor` the clamp needs: a usable area in PHYSICAL
 * pixels, plus the factor that maps those onto the logical ones a window is
 * sized in.
 */
export interface WorkArea {
  size: { width: number; height: number };
  scaleFactor: number;
}

/** A window's requested geometry, in LOGICAL px — the units `WebviewWindow` takes. */
export interface WindowSizeRequest {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}

/**
 * Logical px held back for the native frame. The work area excludes the taskbar
 * but the size below is the window's INNER size, so a window whose inner height
 * exactly filled the work area would still hang off the bottom by its caption
 * bar. One caption's worth of slack is enough to keep the frame on screen
 * without visibly shrinking a window that already fitted.
 */
const FRAME_ALLOWANCE = { width: 8, height: 48 };

/**
 * Clamp a requested logical size to what fits in `area`.
 *
 * The one thing to get right here is the unit conversion, because inverting it
 * IS the bug: the monitor reports PHYSICAL pixels and the window constructor
 * takes LOGICAL ones, so the available logical space is physical DIVIDED by the
 * scale factor. Multiplying instead would report 2880x1620 of room on the very
 * 150% display that only has 1280x720, and clamp nothing.
 *
 * The minimums are clamped too. A minimum larger than the screen is simply
 * unsatisfiable — Tauri honours it, the window can never be shrunk to fit, and
 * whatever hangs off the edge stays there.
 *
 * Pure: `area` is passed in, never queried. `null` means "no monitor to measure
 * against", and the request passes through untouched — a window at its intended
 * size beats a window guessed down to nothing.
 */
export function clampWindowSize(
  request: WindowSizeRequest,
  area: WorkArea | null,
): WindowSizeRequest {
  if (!area) return request;
  // A zero scale factor would divide the screen away entirely; treat it as 1x,
  // the same way the voice-typing overlay does.
  const scale = area.scaleFactor || 1;
  const maxWidth = Math.max(1, Math.floor(area.size.width / scale) - FRAME_ALLOWANCE.width);
  const maxHeight = Math.max(1, Math.floor(area.size.height / scale) - FRAME_ALLOWANCE.height);

  const width = Math.min(request.width, maxWidth);
  const height = Math.min(request.height, maxHeight);
  const clamped: WindowSizeRequest = { width, height };
  if (request.minWidth !== undefined) clamped.minWidth = Math.min(request.minWidth, width);
  if (request.minHeight !== undefined) clamped.minHeight = Math.min(request.minHeight, height);
  return clamped;
}

/**
 * The work area of the display this window is on, or null when it can't be
 * measured (plain-browser dev, or a monitor query that fails).
 *
 * `Monitor.workArea` is the screen minus the taskbar/Dock/menu bar, which is
 * what a window actually gets to occupy — `Monitor.size` is the whole panel and
 * would happily place a window's bottom edge under the taskbar.
 */
async function currentWorkArea(): Promise<WorkArea | null> {
  if (!isTauri()) return null;
  try {
    const { currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (!mon) return null;
    return { size: mon.workArea.size, scaleFactor: mon.scaleFactor };
  } catch (error) {
    log.warn("window: work area lookup failed", { error: String(error) });
    return null;
  }
}

/**
 * Size a secondary window so it fits the display it is about to open on. Spread
 * the result into the `WebviewWindow` options and pass `center: true` alongside
 * it — a window clamped to the work area still needs an origin on screen, and
 * centring is the cheapest way to guarantee one.
 */
export async function fitWindowSize(request: WindowSizeRequest): Promise<WindowSizeRequest> {
  const clamped = clampWindowSize(request, await currentWorkArea());
  if (clamped.width !== request.width || clamped.height !== request.height) {
    log.info("window: clamped to work area", { request, clamped });
  }
  return clamped;
}
