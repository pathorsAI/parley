import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";

/** The floating meeting window's size (the Figma frame), in logical px. */
export const FLOATING_SIZE = { width: 760, height: 858 } as const;
/** The smallest the meeting window OPENS at, on a cramped screen. */
const FLOATING_MIN = { width: 420, height: 480 } as const;
/** How small it may be dragged: below COMPACT it turns into the mini view. */
const DRAG_MIN = { width: 300, height: 220 } as const;
/** Below either of these the window shows the mini view of its tab instead
 *  of the tabs. */
export const COMPACT_BELOW = { width: 360, height: 400 } as const;
/** The mini window ("小窗"): one row — clock, tab icons, expand — over what
 *  the tab it shrank from shows. Its width is fixed; its height follows that. */
export const MINI_WIDTH = 440;
/** The mini window's height per tab: the coach is the bare row (its answer
 *  opens under it), the transcript its last lines, the notes a small box. */
export const MINI_HEIGHT = { coach: 48, coachAnswer: 240, transcript: 176, notes: 200 } as const;
/** Docking: a mini window let go this close to the middle of the screen's top
 *  edge snaps to it — under the notch, by the camera. */
const DOCK_REACH = { x: 160, y: 56 } as const;
/** The docked window's gap under the menu bar. */
const DOCK_GAP = 6;
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

/** The floating window's frame before it shrank to the mini window. */
let beforeMini: { x: number; y: number; width: number; height: number } | null = null;
/** Whether the mini window sits docked under the notch. Remembered across
 *  expanding: the next shrink goes straight back there. */
let docked = false;

/** Where a docked window of `width` goes: centered under the menu bar of the
 *  screen it is on, in logical px. */
async function dockSpot(width: number): Promise<{ x: number; y: number } | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const monitor = await currentMonitor();
  if (!monitor) return null;
  const f = monitor.scaleFactor;
  const area = monitor.workArea;
  return {
    x: Math.round(area.position.x / f + (area.size.width / f - width) / 2),
    y: Math.round(area.position.y / f + DOCK_GAP),
  };
}

/**
 * Shrink the floating window to the mini window `height` tall, or open it
 * back up to the frame it had. A mini window docked before goes back under
 * the notch; otherwise the top-left corner stays put.
 */
export async function setMeetingMini(on: boolean, height: number = MINI_HEIGHT.coach): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    if (on) {
      const size = await win.innerSize();
      const pos = await win.outerPosition();
      beforeMini = { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
      await win.setMinSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT.coach));
      await win.setSize(new LogicalSize(MINI_WIDTH, height));
      const spot = docked ? await dockSpot(MINI_WIDTH) : null;
      if (spot) await win.setPosition(new LogicalPosition(spot.x, spot.y));
    } else {
      // Never "restore" to something the mini window itself left behind.
      const usable = beforeMini && beforeMini.width >= DRAG_MIN.width && beforeMini.height >= DRAG_MIN.height;
      const back = usable && beforeMini ? beforeMini : null;
      await win.setMinSize(new LogicalSize(DRAG_MIN.width, DRAG_MIN.height));
      await win.setSize(new LogicalSize(back?.width ?? FLOATING_SIZE.width, back?.height ?? FLOATING_SIZE.height));
      // Out of the dock, the full window goes back where it was.
      if (docked && back) await win.setPosition(new LogicalPosition(back.x, back.y));
      beforeMini = null;
    }
  } catch (error) {
    log.warn("meeting: mini window toggle failed", { on, error: String(error) });
  }
}

/** Resize the mini window to `height`, for the tab it now shows. */
export async function setMiniHeight(height: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(MINI_WIDTH, height));
  } catch (error) {
    log.warn("meeting: mini window resize failed", { height, error: String(error) });
  }
}

/**
 * Pure: whether a window whose frame is `win` (logical px) was let go close
 * enough to the middle of `area`'s top edge to dock there.
 */
export function nearDock(
  win: { x: number; y: number; width: number },
  area: { x: number; y: number; width: number },
): boolean {
  const center = win.x + win.width / 2;
  const areaCenter = area.x + area.width / 2;
  return Math.abs(center - areaCenter) <= DOCK_REACH.x && win.y - area.y <= DOCK_REACH.y;
}

/**
 * While the mini window shows: once a drag settles, snap it under the notch if
 * it was let go near there, and undock it if it was dragged away.
 */
export function useMiniDocking(active: boolean): void {
  useEffect(() => {
    if (!active || !isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let gone = false;

    async function settle() {
      try {
        const { getCurrentWindow, currentMonitor, LogicalPosition } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const monitor = await currentMonitor();
        if (!monitor) return;
        const f = monitor.scaleFactor;
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        const frame = { x: pos.x / f, y: pos.y / f, width: size.width / f };
        const area = monitor.workArea;
        docked = nearDock(frame, {
          x: area.position.x / f,
          y: area.position.y / f,
          width: area.size.width / f,
        });
        if (!docked) return;
        const spot = await dockSpot(frame.width);
        // Already there: setting it again would only fire another move.
        if (spot && (Math.abs(spot.x - frame.x) > 1 || Math.abs(spot.y - frame.y) > 1)) {
          await win.setPosition(new LogicalPosition(spot.x, spot.y));
        }
      } catch (error) {
        log.warn("meeting: mini window dock failed", { error: String(error) });
      }
    }

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onMoved(() => {
        clearTimeout(timer);
        timer = setTimeout(() => void settle(), 220);
      });
      if (gone) off();
      else unlisten = off;
    });
    return () => {
      gone = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [active]);
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
    .catch((error) => log.warn("meeting: mini window drag failed", { error: String(error) }));
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
