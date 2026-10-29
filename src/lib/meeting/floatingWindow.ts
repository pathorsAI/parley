import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";

/** The floating meeting window's size (the Figma frame), in logical px. */
export const FLOATING_SIZE = { width: 760, height: 858 } as const;
/** The smallest the window OPENS at, on a cramped screen. */
const FLOATING_MIN = { width: 420, height: 480 } as const;
/** How small it may be dragged: below COMPACT it turns into the compact view. */
const DRAG_MIN = { width: 300, height: 220 } as const;
/** Below either of these the window shows the compact view (latest caption
 *  and coach tip) instead of the tabs. */
export const COMPACT_BELOW = { width: 360, height: 400 } as const;
/** The collapsed capsule ("小膠囊"): one row with the clock and an ask box. */
export const PILL_SIZE = { width: 380, height: 48 } as const;
/** The capsule with the coach's answer open under its row. */
export const PILL_ANSWER_HEIGHT = 240;
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
      await win.setMinSize(new LogicalSize(DRAG_MIN.width, DRAG_MIN.height));
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

/** The floating window's size before it collapsed into the capsule. */
let beforePill: { width: number; height: number } | null = null;

/**
 * Collapse the floating window into the capsule, or open it back up to the
 * size it had. Its top-left corner stays put either way.
 */
export async function setMeetingPill(on: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (on) {
      const scale = await win.scaleFactor();
      const size = await win.innerSize();
      beforePill = { width: size.width / scale, height: size.height / scale };
      await win.setMinSize(new LogicalSize(PILL_SIZE.width, PILL_SIZE.height));
      await win.setSize(new LogicalSize(PILL_SIZE.width, PILL_SIZE.height));
    } else {
      const back = beforePill ?? FLOATING_SIZE;
      beforePill = null;
      await win.setMinSize(new LogicalSize(DRAG_MIN.width, DRAG_MIN.height));
      await win.setSize(new LogicalSize(back.width, back.height));
    }
  } catch (error) {
    log.warn("meeting: capsule toggle failed", { on, error: String(error) });
  }
}

/** Grow the capsule to show an answer under its row, or shrink it back. */
export async function setPillAnswerOpen(open: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const height = open ? PILL_ANSWER_HEIGHT : PILL_SIZE.height;
    await getCurrentWindow().setSize(new LogicalSize(PILL_SIZE.width, height));
  } catch (error) {
    log.warn("meeting: capsule answer resize failed", { open, error: String(error) });
  }
}

/**
 * Drag the window from a press anywhere on `el` that is not a control. Not a
 * `data-tauri-drag-region`: a double-click there zooms the window to fill the
 * screen, which turned the capsule into a screen-sized oval.
 */
export function dragWindowFrom(e: { button: number; target: EventTarget; detail: number }): void {
  if (e.button !== 0 || !isTauri()) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, textarea, a, [role=option]")) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
    .catch((error) => log.warn("meeting: capsule drag failed", { error: String(error) }));
}
