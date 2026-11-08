import { useEffect } from "react";
import { isTauri } from "../platform";
import { log } from "../log";
import * as ipc from "../ipc/commands";

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
/** One line of the mini window's transcript and notes. */
export const MINI_LINE = 22;
/** The least the mini window may be dragged to per tab: the coach's bare row;
 *  the transcript and notes keep one whole line under it (row 48 + border 1
 *  + 8px padding above and below). */
export const MINI_MIN_HEIGHT = { coach: 48, transcript: 48 + 1 + 16 + MINI_LINE, notes: 48 + 1 + 16 + MINI_LINE } as const;
/** Docking, like a magnet: a mini window brought this close to the screen's
 *  top edge — anywhere along it — snaps to the nearest of its three spots:
 *  the top-left corner, the middle (under the notch by the camera), or the
 *  top-right corner. */
const DOCK_REACH = 72;
/** How long the window rests before the magnet pulls (or lets go). */
const DOCK_SETTLE_MS = 120;
/** A docked window's gap under the menu bar, and the corner spots' gap from
 *  the screen's left and right edges. */
const DOCK_GAP = 8;
/** How long the window glides to a new frame: docking, shrinking, growing,
 *  and its height following the mini window's tab. */
const GLIDE_MS = 240;
/** The main window's own minimum (tauri.conf.json), restored afterwards. */
const MAIN_MIN = { width: 900, height: 600 } as const;
/** The main window's default size (tauri.conf.json). */
const MAIN_DEFAULT = { width: 1200, height: 800 } as const;
/** Gap kept between the floating window and the screen's edges. */
const EDGE = 24;

/** The widest the full meeting window opens or grows: a third of the screen,
 *  so it sits beside a call instead of over it — but never so narrow that it
 *  flips into the compact view. */
export function maxFullWidth(screenWidth: number): number {
  return Math.max(COMPACT_BELOW.width, Math.floor(screenWidth / 3));
}

/**
 * Where the floating window goes on a screen of `screen` logical px whose
 * top-left is at `origin`: the frame's size, shrunk to fit, against the right
 * edge — over the side of a video call rather than its middle.
 */
export function floatingFrame(
  screen: { width: number; height: number },
  origin: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(
    maxFullWidth(screen.width),
    Math.max(FLOATING_MIN.width, Math.min(FLOATING_SIZE.width, screen.width - EDGE * 2)),
  );
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

type Frame = { x: number; y: number; width: number; height: number };
type Area = { x: number; y: number; width: number };
type FullArea = Area & { height: number };

/** Gap a grown window keeps from the screen's edges. */
const FIT_GAP = 8;

/**
 * Pure: `frame` made to fit inside `area` (a screen's work area): no larger
 * than the area less a small gap on each side (and no wider than a third of
 * it, maxFullWidth), and moved back on screen —
 * the way a window grown near an edge (a mini window docked in the corner,
 * say) opens up without running off it.
 */
export function fitToArea(frame: Frame, area: FullArea): Frame {
  const width = Math.min(frame.width, area.width - FIT_GAP * 2, maxFullWidth(area.width));
  const height = Math.min(frame.height, area.height - FIT_GAP * 2);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: Math.round(clamp(frame.x, area.x + FIT_GAP, area.x + area.width - width - FIT_GAP)),
    y: Math.round(clamp(frame.y, area.y + FIT_GAP, area.y + area.height - height - FIT_GAP)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Where a mini window can dock: the top-left corner, under the notch, or
 *  the top-right corner ("corner"). */
export type DockSpot = "left" | "notch" | "corner";
const DOCK_SPOTS: readonly DockSpot[] = ["left", "notch", "corner"];

/** The floating window's frame before it shrank to the mini window. */
let beforeMini: Frame | null = null;
/** Where the mini window sits docked, if it does. Remembered across
 *  expanding: the next shrink goes straight back there. */
let docked: DockSpot | null = null;
/** Until when the window is gliding: its own moves are not a drag to dock. */
let glidingUntil = 0;

/**
 * Pure: the spot a window whose frame is `win` (logical px) docks to on
 * `area` — the screen its middle is on — or null when it is not close enough
 * to the top edge. Along that edge it goes to the nearest spot.
 */
export function dockTarget(win: { x: number; y: number; width: number }, area: Area): DockSpot | null {
  const center = win.x + win.width / 2;
  const onScreen = center >= area.x && center < area.x + area.width;
  if (!onScreen || win.y - area.y > DOCK_REACH) return null;
  const gap = (spot: DockSpot) => Math.abs(center - (dockPosition(spot, area, win.width).x + win.width / 2));
  return DOCK_SPOTS.reduce((best, spot) => (gap(spot) < gap(best) ? spot : best));
}

/** Pure: the top-left corner of a window `width` wide docked at `spot`. */
export function dockPosition(spot: DockSpot, area: Area, width: number): { x: number; y: number } {
  const x =
    spot === "left"
      ? area.x + DOCK_GAP
      : spot === "notch"
        ? area.x + (area.width - width) / 2
        : area.x + area.width - width - DOCK_GAP;
  return { x: Math.round(x), y: Math.round(area.y + DOCK_GAP) };
}

/** The work area (below the menu bar) of the screen the window is on, in
 *  logical px. */
async function screenArea(): Promise<FullArea | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const monitor = await currentMonitor();
  if (!monitor) return null;
  const f = monitor.scaleFactor;
  const a = monitor.workArea;
  return { x: a.position.x / f, y: a.position.y / f, width: a.size.width / f, height: a.size.height / f };
}

/**
 * Grow the full meeting window to `size` with its top-left at `at`, fitted to
 * the screen it is on. Resolves once the glide has ended.
 */
export async function growMeetingWindow(at: { x: number; y: number }, size: { width: number; height: number }): Promise<void> {
  const area = await screenArea();
  const want = { x: at.x, y: at.y, width: size.width, height: size.height };
  await glide(area ? fitToArea(want, area) : want);
  await new Promise((resolve) => setTimeout(resolve, GLIDE_MS));
}

/** The full window's size the last time it shrank to the mini window, so
 *  growing back from a dragged-small window opens to it too. */
let lastFullSize: { width: number; height: number } | null = null;

/** The window's current frame, in logical px. */
async function currentFrame(): Promise<Frame> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  const size = await win.innerSize();
  return { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
}

/** Glide the window to `frame` (natively on macOS; set at once elsewhere).
 *  Resolves when the glide has started, not when it ends. */
async function glide(frame: Frame): Promise<void> {
  glidingUntil = Date.now() + GLIDE_MS + 60;
  await ipc.animateWindowFrame({ ...frame, durationMs: GLIDE_MS });
}

/**
 * Shrink the floating window to the mini window `height` tall, or open it
 * back up to the frame it had. A mini window docked before goes back to its
 * spot; otherwise the top-left corner stays put. Shrinking resolves as the
 * glide starts (the mini view then shows while the window shrinks); growing
 * resolves once it has ended, so the full layout only renders at full size.
 */
export async function setMeetingMini(
  on: boolean,
  height: number = MINI_HEIGHT.coach,
  minHeight: number = MINI_MIN_HEIGHT.coach,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const now = await currentFrame();
    if (on) {
      beforeMini = now;
      if (now.width >= DRAG_MIN.width && now.height >= DRAG_MIN.height) {
        lastFullSize = { width: now.width, height: now.height };
      }
      await win.setMinSize(new LogicalSize(MINI_WIDTH, minHeight));
      const area = docked ? await screenArea() : null;
      const at = docked && area ? dockPosition(docked, area, MINI_WIDTH) : now;
      await glide({ x: at.x, y: at.y, width: MINI_WIDTH, height });
    } else {
      // Never "restore" to something the mini window itself left behind.
      const usable = beforeMini && beforeMini.width >= DRAG_MIN.width && beforeMini.height >= DRAG_MIN.height;
      const back = usable && beforeMini ? beforeMini : null;
      beforeMini = null;
      await win.setMinSize(new LogicalSize(DRAG_MIN.width, DRAG_MIN.height));
      // Out of the dock, the full window goes back where it was.
      const at = docked && back ? back : now;
      // Its last size (or the frame's), never past the screen's edges.
      await growMeetingWindow(at, back ?? lastFullSize ?? FLOATING_SIZE);
    }
  } catch (error) {
    log.warn("meeting: mini window toggle failed", { on, error: String(error) });
  }
}

/** Fit the window, as it stands, back inside its screen (the same rule as
 *  growing); nothing moves when it already fits. */
async function refitMeetingWindow(): Promise<void> {
  const area = await screenArea();
  if (!area) return;
  const now = await currentFrame();
  const fitted = fitToArea(now, area);
  const same = (["x", "y", "width", "height"] as const).every((k) => Math.abs(fitted[k] - now[k]) < 1);
  if (!same) await glide(fitted);
}

/**
 * Into the Dock (the taskbar on Windows); the recording carries on. When it
 * comes back out it opens the way growing does: never past the screen's
 * edges, nor wider than a third of it.
 */
export async function minimizeMeetingWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    unlisten = await win.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      void win.isMinimized().then((minimized) => {
        if (minimized) return;
        unlisten?.();
        unlisten = null;
        void refitMeetingWindow().catch((error: unknown) =>
          log.warn("meeting: floating window refit failed", { error: String(error) }),
        );
      });
    });
    await win.minimize();
  } catch (error) {
    log.warn("meeting: floating window minimize failed", { error: String(error) });
  }
}

/** Out of a full window dragged small: back to its last full size (or the
 *  frame's), fitted to the screen. */
export async function growFromCompactWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const now = await currentFrame();
    await growMeetingWindow(now, lastFullSize ?? FLOATING_SIZE);
  } catch (error) {
    log.warn("meeting: floating window grow failed", { error: String(error) });
  }
}

/** Glide the mini window to `height` and hold it at least `minHeight`, for
 *  the tab it now shows. */
export async function setMiniHeight(height: number, minHeight: number = MINI_MIN_HEIGHT.coach): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setMinSize(new LogicalSize(MINI_WIDTH, minHeight));
    const now = await currentFrame();
    await glide({ x: now.x, y: now.y, width: MINI_WIDTH, height });
  } catch (error) {
    log.warn("meeting: mini window resize failed", { height, error: String(error) });
  }
}

/** Hold the mini window at least `minHeight` tall, growing it to that if it
 *  is shorter — the mini window as it first shows, whatever it was before. */
export async function holdMiniMinHeight(minHeight: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setMinSize(new LogicalSize(MINI_WIDTH, minHeight));
    const now = await currentFrame();
    if (now.height < minHeight - 0.5) await glide({ ...now, height: minHeight });
  } catch (error) {
    log.warn("meeting: mini window minimum failed", { minHeight, error: String(error) });
  }
}

/**
 * While the mini window shows: whenever it rests near the top edge, pull it
 * to the nearer dock spot; dragged away from there, it undocks.
 */
export function useMiniDocking(active: boolean): void {
  useEffect(() => {
    if (!active || !isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let gone = false;

    const later = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void settle(), ms);
    };

    async function settle() {
      // Its own glide moves the window too; look again once it has landed.
      const wait = glidingUntil - Date.now();
      if (wait > 0) return later(wait);
      try {
        const [frame, area] = await Promise.all([currentFrame(), screenArea()]);
        if (!area) return;
        docked = dockTarget(frame, area);
        if (!docked) return;
        const at = dockPosition(docked, area, frame.width);
        // Already there: gliding again would only fire another move.
        if (Math.abs(at.x - frame.x) > 1 || Math.abs(at.y - frame.y) > 1) {
          await glide({ ...frame, x: at.x, y: at.y });
        }
      } catch (error) {
        log.warn("meeting: mini window dock failed", { error: String(error) });
      }
    }

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onMoved(() => later(DOCK_SETTLE_MS));
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
 * Drag the window from a press anywhere on `el` that is not a control (or
 * marked `data-no-drag`, like the selectable transcript). Not a
 * `data-tauri-drag-region`: a double-click there zooms the window to fill the
 * screen, which turned the capsule into a screen-sized oval.
 */
export function dragWindowFrom(e: { button: number; target: EventTarget; detail: number }): void {
  if (e.button !== 0 || !isTauri()) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, textarea, a, [role=option], [data-no-drag]")) return;
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
