import * as ipc from "../ipc/commands";

/**
 * The calling window's frame on screen: where it is, how big, and the screen
 * it is on — in logical px, top-left origin. Shared by the meeting window's
 * docking / mini window (lib/meeting/floatingWindow.ts) and the title-bar
 * double-click zoom (./zoom.ts).
 */

export type Frame = { x: number; y: number; width: number; height: number };
/** A screen's work area (below the menu bar, beside the Dock), logical px. */
export type ScreenArea = Frame;

/** How long the window glides to a new frame. */
export const GLIDE_MS = 240;

/** Until when the window is gliding: its own moves are not the user's. */
let glidingUntil = 0;

/** Milliseconds left of the window's own glide (0 when it is not gliding). */
export function glideRemainingMs(): number {
  return Math.max(0, glidingUntil - Date.now());
}

/** The work area (below the menu bar) of the screen the window is on, in
 *  logical px. */
export async function screenArea(): Promise<ScreenArea | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const monitor = await currentMonitor();
  if (!monitor) return null;
  const f = monitor.scaleFactor;
  const a = monitor.workArea;
  return { x: a.position.x / f, y: a.position.y / f, width: a.size.width / f, height: a.size.height / f };
}

/** The window's current frame, in logical px. */
export async function currentFrame(): Promise<Frame> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  const size = await win.innerSize();
  return { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
}

/** Glide the window to `frame` (natively on macOS; set at once elsewhere).
 *  Resolves when the glide has started, not when it ends. */
export async function glide(frame: Frame): Promise<void> {
  glidingUntil = Date.now() + GLIDE_MS + 60;
  await ipc.animateWindowFrame({ ...frame, durationMs: GLIDE_MS });
}

/**
 * Pure: `frame` made to fit inside `area`: no larger than the area less `gap`
 * on each side (nor wider than `maxWidth`), and moved back on screen.
 */
export function clampToArea(frame: Frame, area: ScreenArea, gap: number, maxWidth = Infinity): Frame {
  const width = Math.min(frame.width, area.width - gap * 2, maxWidth);
  const height = Math.min(frame.height, area.height - gap * 2);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: Math.round(clamp(frame.x, area.x + gap, area.x + area.width - width - gap)),
    y: Math.round(clamp(frame.y, area.y + gap, area.y + area.height - height - gap)),
    width: Math.round(width),
    height: Math.round(height),
  };
}
