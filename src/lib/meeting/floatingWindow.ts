import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";

/** The floating meeting window's size (the Figma frame), in logical px. */
export const FLOATING_SIZE = { width: 760, height: 858 } as const;
/** How small the floating window may be dragged. */
const FLOATING_MIN = { width: 420, height: 480 } as const;
/** The main window's own minimum (tauri.conf.json), restored afterwards. */
const MAIN_MIN = { width: 900, height: 600 } as const;
/** Gap kept between the floating window and the screen's edges. */
const EDGE = 24;

/**
 * Where the floating window goes on a screen of `screen` logical px whose
 * top-left is at `origin`: the frame's size, shrunk to fit, against the right
 * edge — over the side of a video call rather than its middle.
 */
export function floatingFrame(
  screen: { width: number; height: number },
  origin: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(FLOATING_MIN.width, Math.min(FLOATING_SIZE.width, screen.width - EDGE * 2));
  const height = Math.max(FLOATING_MIN.height, Math.min(FLOATING_SIZE.height, screen.height - EDGE * 3));
  return {
    x: origin.x + Math.max(0, screen.width - width - EDGE),
    y: origin.y + Math.max(0, Math.round((screen.height - height) / 2)),
    width,
    height,
  };
}

interface Restore {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * While a meeting runs the main window IS the floating window: it shrinks to
 * the frame's size, moves to the side of the screen and stays above the call.
 * When the meeting is over it goes back to where and how big it was.
 *
 * One window rather than a second one, so the live meeting state never has to
 * cross a window boundary — the store that records is the store that shows.
 */
export function useFloatingMeetingWindow(on: boolean): void {
  useEffect(() => {
    if (!on || !isTauri()) return;
    let restore: Restore | null = null;
    let cancelled = false;

    const enter = (async () => {
      const { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } = await import(
        "@tauri-apps/api/window"
      );
      const win = getCurrentWindow();
      if (await win.isFullscreen()) await win.setFullscreen(false);
      const scale = await win.scaleFactor();
      const [size, pos] = await Promise.all([win.outerSize(), win.outerPosition()]);
      restore = {
        width: size.width / scale,
        height: size.height / scale,
        x: pos.x / scale,
        y: pos.y / scale,
      };
      if (cancelled) return;
      const monitor = await currentMonitor();
      // The work area leaves out the menu bar, Dock and taskbar.
      const area = monitor?.workArea;
      const frame = monitor && area
        ? floatingFrame(
            { width: area.size.width / monitor.scaleFactor, height: area.size.height / monitor.scaleFactor },
            { x: area.position.x / monitor.scaleFactor, y: area.position.y / monitor.scaleFactor },
          )
        : floatingFrame({ width: FLOATING_SIZE.width + EDGE * 2, height: FLOATING_SIZE.height + EDGE * 3 });
      await win.setMinSize(new LogicalSize(FLOATING_MIN.width, FLOATING_MIN.height));
      await win.setSize(new LogicalSize(frame.width, frame.height));
      await win.setPosition(new LogicalPosition(frame.x, frame.y));
      await win.setAlwaysOnTop(true);
      log.info("meeting: floating window on", frame);
    })().catch((error) => log.warn("meeting: floating window failed", { error: String(error) }));

    return () => {
      cancelled = true;
      void enter
        .then(async () => {
          const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.setAlwaysOnTop(false);
          await win.setMinSize(new LogicalSize(MAIN_MIN.width, MAIN_MIN.height));
          if (restore) {
            await win.setSize(new LogicalSize(restore.width, restore.height));
            await win.setPosition(new LogicalPosition(restore.x, restore.y));
          }
          log.info("meeting: floating window off");
        })
        .catch((error) => log.warn("meeting: leaving the floating window failed", { error: String(error) }));
    };
  }, [on]);
}
