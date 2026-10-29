import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";

/** The floating meeting window's size (the Figma frame), in logical px. */
export const FLOATING_SIZE = { width: 760, height: 858 } as const;
/** The smallest the meeting window OPENS at, on a cramped screen. */
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
/** The main window's default size (tauri.conf.json). */
const MAIN_DEFAULT = { width: 1200, height: 800 } as const;
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

/**
 * The main window, at startup: undo anything a floating main window left
 * behind (see repairMainWindow). The meeting floats in its own window now
 * (meetingWindow.ts), but builds before that floated the main window itself.
 */
export function useMainWindowRepair(): void {
  useEffect(() => {
    if (isTauri()) void repairMainWindow();
  }, []);
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
      // Never "restore" to something the capsule itself left behind.
      const usable =
        beforePill && beforePill.width >= DRAG_MIN.width && beforePill.height >= DRAG_MIN.height;
      const back = usable && beforePill ? beforePill : FLOATING_SIZE;
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

const fitsMain = (r: { width: number; height: number }) =>
  r.width >= MAIN_MIN.width && r.height >= MAIN_MIN.height;

/**
 * Put the main window back to being the main window: not always on top, its
 * 900 x 600 minimum, and a normal size if it is smaller than that. A build
 * that floated the main window during meetings could leave it capsule-sized
 * and pinned when a reload lost its restore. A no-op on a healthy window.
 */
async function repairMainWindow(): Promise<void> {
  try {
    const { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } = await import(
      "@tauri-apps/api/window"
    );
    const win = getCurrentWindow();
    // Measure before restoring the minimum: the minimum alone already grows
    // a capsule-sized window, which would then look healthy.
    const scale = await win.scaleFactor();
    const size = await win.innerSize();
    await win.setAlwaysOnTop(false);
    await win.setMinSize(new LogicalSize(MAIN_MIN.width, MAIN_MIN.height));
    if (fitsMain({ width: size.width / scale, height: size.height / scale })) return;
    const monitor = await currentMonitor();
    const area = monitor?.workArea;
    const width = MAIN_DEFAULT.width;
    const height = MAIN_DEFAULT.height;
    await win.setSize(new LogicalSize(width, height));
    if (monitor && area) {
      const f = monitor.scaleFactor;
      await win.setPosition(
        new LogicalPosition(
          area.position.x / f + Math.max(0, (area.size.width / f - width) / 2),
          area.position.y / f + Math.max(0, (area.size.height / f - height) / 2),
        ),
      );
    }
    log.info("window: main window repaired after a lost floating-window restore");
  } catch (error) {
    log.warn("window: main window repair failed", { error: String(error) });
  }
}
