//! Lifecycle for the floating voice-typing overlay window: a transparent,
//! always-on-top, non-focusing panel pinned to the bottom-centre of the display
//! the mouse pointer sits on. Created once (hidden) and shown/repositioned per
//! dictation. Only what it draws catches clicks; the transparent rest of the
//! window passes them to the app behind (macOS — see hitRegions.ts).

import { isTauri } from "../tauriEvents";
import { log } from "../log";
import type { PolishOutcome } from "./polish";

const LABEL = "voice-typing";
const WIDTH = 460;
/**
 * The overlay's content is a bottom-anchored stack (VoiceTypingApp), and this
 * is its budget. With 16 px of bottom padding and 8 px gaps, the common states
 * fit: done with a full three-line transcript is 16 + 36 pill + 22.5 note +
 * 84 transcript + 2 × 8 = 174.5 px, polishing 172.5 px, a two-line dictionary
 * suggestion about 138 px. Only the rare hosted-cap note overflows; the
 * transcript bubble (overflow-hidden) then gives up about a line — it is
 * still pasted whole. There used to be a "Parley" wordmark under the pill;
 * its 30 px squeezed every done state, so it went.
 */
const HEIGHT = 180;
/** Gap above the bottom of the WORK AREA (sits low, just clearing the Dock). */
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
      // Windows: WS_EX_NOACTIVATE from creation, which tao then keeps through
      // its own style rewrites. macOS: it only shapes the TaoWindow, and
      // present_voice_overlay swaps that class for NSPanel anyway. NEVER call
      // setFocusable (or any other window-flag setter) on this window at
      // runtime: after the swap tao would read an ivar NSPanel does not have,
      // and on Windows the setter hides the window and strips its ex-styles
      // (see imp::present_overlay in voice_typing.rs).
      focusable: false,
      // The panel never activates Parley (voice_typing.rs, prevent_activation),
      // so every click on it is a first mouse in a non-key window of an
      // inactive app — and WKWebView drops those unless it accepts first
      // mouse. Without this the suggestion buttons stop receiving pointerdown.
      acceptFirstMouse: true,
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
  /**
   * Tauri's `Monitor.workArea` (@tauri-apps/api 2.11): the display minus the
   * taskbar / Dock / menu bar, in physical px. Optional because callers that
   * only hold raw display bounds are still valid input — see
   * bottomCenterPhysical for what happens then.
   */
  workArea?: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
  scaleFactor: number;
};

/**
 * Bottom-centre of `mon`'s WORK AREA for the WIDTH×HEIGHT (logical px) overlay,
 * returned in PHYSICAL px.
 *
 * Physical rather than logical because Tauri converts a logical position using
 * the window's CURRENT scale factor — which is still the old display's while
 * the overlay is being moved onto another one. On a mixed-DPI setup (Retina +
 * external 1x) that lands it at double/half the intended offset. Monitor
 * geometry is already physical, so doing the whole calculation there sidesteps
 * the conversion.
 *
 * The work area, not the full display: BOTTOM_MARGIN clears a default Windows
 * taskbar but not a taller one, nor one stacked two rows deep, so measuring
 * from the screen bottom could leave the pill behind it. Displays that report
 * no work area fall back to their full bounds — the old behaviour — rather than
 * having a taskbar height guessed for them.
 */
export function bottomCenterPhysical(mon: MonitorGeometry): { x: number; y: number } {
  const scale = mon.scaleFactor || 1;
  const area = mon.workArea ?? { position: mon.position, size: mon.size };
  return {
    x: Math.round(area.position.x + (area.size.width - WIDTH * scale) / 2),
    y: Math.round(area.position.y + area.size.height - (HEIGHT + BOTTOM_MARGIN) * scale),
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

/**
 * The `message` of the host's `{ phase: "done" }` event — what the overlay's
 * closing confirmation says about a finished dictation:
 *
 * - `empty`: nothing was said, so nothing was copied.
 * - `clipboard-only`: copied, but the synthetic paste was refused (no
 *   Accessibility on macOS, UIPI on Windows) or went to Parley itself (the
 *   host decides that one); the overlay names the paste key.
 * - `ok-unpolished`: pasted, but as dictated, because the polish pass was
 *   attempted and did not come back (timed out, or the request failed).
 * - `ok`: pasted — polished, or with no polish to expect.
 *
 * Two more come only from an Undo of an Esc-cancelled dictation (host.ts,
 * deliverRecovered), never from {@link doneMessage}:
 *
 * - `recovered`: copied to the clipboard (Undo never pastes).
 * - `nothing`: the cancelled dictation had no text to bring back.
 */
export type DoneMessage =
  | "empty"
  | "clipboard-only"
  | "ok-unpolished"
  | "ok"
  | "recovered"
  | "nothing";

/**
 * Pick the {@link DoneMessage} for one finalized dictation.
 *
 * Only a polish that was tried and broke gets a note. When it never ran (off,
 * too short) the user is not waiting on it; when the answer was refused by the
 * guard, the raw text is the guard working as designed. But a timeout or a
 * failed request means the "polishing…" beat the user just sat through
 * produced nothing — and pasting the raw text under a plain "Copied" is what
 * kept a CORS failure that broke every hosted polish on the Mac out of sight.
 * A refused paste outranks all of it: that note tells the user to act.
 */
export function doneMessage(d: {
  text: string;
  pasted: boolean;
  outcome: PolishOutcome;
}): DoneMessage {
  if (!d.text) return "empty";
  if (!d.pasted) return "clipboard-only";
  if (d.outcome === "timedOut" || d.outcome === "failed") return "ok-unpolished";
  return "ok";
}
