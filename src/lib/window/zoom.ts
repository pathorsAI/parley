import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";
import { MAIN_DEFAULT, floatingFrame } from "../meeting/floatingWindow";
import {
  clampToArea,
  currentFrame,
  glide,
  glideRemainingMs,
  screenArea,
  type Frame,
  type ScreenArea,
} from "./frame";

/**
 * Double-click the title bar to zoom, the way Chrome does: a window that fills
 * the screen goes back to the frame it had before, any other window fills the
 * screen. Our windows are borderless, and Tauri's toggleMaximize does nothing
 * useful on a window macOS TILED to fill the screen (dragged to the top edge):
 * the window is not "maximized" as far as it knows and has no frame to go back
 * to. So the app keeps that frame itself, per window, and glides between the
 * two (animate_window_frame).
 */

/**
 * How far, per edge, a window may stop short of the work area and still
 * "fill" it: macOS tiling can leave margins around a tiled window (System
 * Settings › Desktop & Dock › Tiled windows have margins), a few px each.
 */
export const FILL_SLACK = 20;

/** Gap a restored window keeps from the screen's edges. */
const RESTORE_GAP = 8;

/** Pure: does `frame` cover the work area `area`, give or take FILL_SLACK on
 *  each edge? */
export function isFilling(frame: Frame, area: ScreenArea): boolean {
  return (
    frame.x <= area.x + FILL_SLACK &&
    frame.y <= area.y + FILL_SLACK &&
    frame.x + frame.width >= area.x + area.width - FILL_SLACK &&
    frame.y + frame.height >= area.y + area.height - FILL_SLACK
  );
}

/** Pure: `size` centred on `area`, fitted inside it. */
export function centredFrame(size: { width: number; height: number }, area: ScreenArea): Frame {
  const centred = {
    x: area.x + (area.width - size.width) / 2,
    y: area.y + (area.height - size.height) / 2,
    width: size.width,
    height: size.height,
  };
  return clampToArea(centred, area, RESTORE_GAP);
}

/**
 * Pure: where a remembered frame goes back to on `area` (the screen the window
 * fills now): its own size and place, fitted inside the screen — no third-of-
 * the-screen cap here, the user chose that size. A frame remembered on another
 * screen (its middle is off this one) keeps its size, centred here.
 */
export function restoreFrame(remembered: Frame, area: ScreenArea): Frame {
  const cx = remembered.x + remembered.width / 2;
  const cy = remembered.y + remembered.height / 2;
  const onArea = cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height;
  return onArea ? clampToArea(remembered, area, RESTORE_GAP) : centredFrame(remembered, area);
}

/** The frame a window goes back to when it remembers none, for the screen
 *  `area`. */
export type ZoomFallback = (area: ScreenArea) => Frame;

/** The main window: its default size (tauri.conf.json), centred. */
export const mainZoomFallback: ZoomFallback = (area) => centredFrame(MAIN_DEFAULT, area);

/** The meeting window: where it first opens — the frame's size, no wider than
 *  a third of the screen, against the right edge (floatingFrame). */
export const meetingZoomFallback: ZoomFallback = (area) => floatingFrame(area, area);

/** The last frame this window had that did not fill its screen. Each window is
 *  its own webview, so a module-level slot is per window. */
let remembered: Frame | null = null;
/** Which frames are worth going back to (the meeting window: not the mini
 *  window's). */
let accept: (frame: Frame) => boolean = () => true;
let tracking = false;

/** How long the window rests after a move or resize before its frame is
 *  read. */
const SETTLE_MS = 150;

/**
 * Remember this window's last frame that does not fill the screen, from now
 * on: read once at the start, then whenever it settles after a move or resize
 * (not while its own glide moves it). Idempotent: the first call per window
 * starts it; later calls only update `acceptFrame`. No-op off Tauri.
 */
export function trackRestoreFrame(acceptFrame: (frame: Frame) => boolean = () => true): void {
  accept = acceptFrame;
  if (tracking || !isTauri()) return;
  tracking = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void settle(), ms);
  };
  async function settle() {
    const wait = glideRemainingMs();
    if (wait > 0) return later(wait);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if ((await win.isMinimized()) || (await win.isFullscreen())) return;
      const [frame, area] = await Promise.all([currentFrame(), screenArea()]);
      if (area && !isFilling(frame, area) && accept(frame)) remembered = frame;
    } catch (error) {
      log.warn("window: reading the frame failed", { error: String(error) });
    }
  }
  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      await win.onMoved(() => later(SETTLE_MS));
      await win.onResized(() => later(SETTLE_MS));
      later(0);
    })
    .catch((error: unknown) => {
      tracking = false;
      log.warn("window: frame tracking failed", { error: String(error) });
    });
}

/** trackRestoreFrame, from a component: the main window's title bar and the
 *  meeting window. Listens for as long as the window lives. */
export function useTrackRestoreFrame(enabled = true, acceptFrame?: (frame: Frame) => boolean): void {
  useEffect(() => {
    if (enabled) trackRestoreFrame(acceptFrame);
  }, [enabled, acceptFrame]);
}

/**
 * The title bar's double click: a window that fills its screen glides back to
 * the frame it last had that did not (or `fallback`'s, when it has none); any
 * other window remembers its frame and glides to fill the work area. Nothing
 * happens in fullscreen, nor off Tauri.
 */
export async function toggleZoom(fallback: ZoomFallback): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (await getCurrentWindow().isFullscreen()) return;
    const [frame, area] = await Promise.all([currentFrame(), screenArea()]);
    if (!area) return;
    if (isFilling(frame, area)) {
      await glide(remembered ? restoreFrame(remembered, area) : fallback(area));
    } else {
      if (accept(frame)) remembered = frame;
      await glide({ x: area.x, y: area.y, width: area.width, height: area.height });
    }
  } catch (error) {
    log.warn("window: zoom failed", { error: String(error) });
  }
}

