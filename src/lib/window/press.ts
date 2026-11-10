import { isMac, isTauri } from "../platform";
import { log } from "../log";

/**
 * A press on a window's title bar: drag the window, or — on a double click —
 * run the title bar's double-click action. The same pattern as Tauri's own
 * `data-tauri-drag-region` script (tauri/src/window/scripts/drag.js), which we
 * cannot use where its double click would call toggleMaximize:
 *
 * - the first press (detail 1) starts a native drag at once. On macOS the drag
 *   loop swallows that press's mouseup, but the system still counts the next
 *   press as the second click, so it arrives with detail 2;
 * - the second press (detail 2) does not drag. On macOS the action waits for
 *   its mouseup and is dropped if the pointer moved in between (the system
 *   behaviour: a double click that turns into a drag does nothing); elsewhere
 *   it runs on the press.
 */

/** What keeps the mouse instead of dragging the window: anything you click,
 *  type or select in (a contenteditable — the rich-text notes — is a <div>,
 *  so it needs naming on its own), and whatever is marked `data-no-drag`. */
export const NO_DRAG =
  'button, input, textarea, select, label, summary, a, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=option], [contenteditable="true"], [data-no-drag]';

/** Is `target` (or an ancestor) a control that keeps the mouse? */
export function isOnControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_DRAG) !== null;
}

type Press = { button: number; detail: number; clientX: number; clientY: number };

/**
 * Drag the window from `e` — a press the caller has already decided lands on
 * a bare stretch of title bar — or, on its second click, run `onDoubleClick`.
 * Without `onDoubleClick`, every press drags (a double click does nothing
 * more). No-op off Tauri and for any button but the left one.
 */
export function pressTitleBar(e: Press, onDoubleClick?: () => void): void {
  if (e.button !== 0 || !isTauri()) return;
  if (onDoubleClick && e.detail === 2) {
    if (!isMac()) {
      onDoubleClick();
      return;
    }
    const { clientX, clientY } = e;
    window.addEventListener(
      "mouseup",
      (up) => {
        if (up.button === 0 && up.detail === 2 && up.clientX === clientX && up.clientY === clientY) onDoubleClick();
      },
      { once: true, capture: true },
    );
    return;
  }
  // A third click (and on) neither drags nor zooms again, as with Tauri's.
  if (onDoubleClick && e.detail !== 1) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
    .catch((error) => log.warn("window: drag failed", { error: String(error) }));
}
