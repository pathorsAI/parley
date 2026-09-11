import { useSyncExternalStore } from "react";

/**
 * Whether the main window's left tree is collapsed (⌘B).
 *
 * Kept beside the panel layout it belongs to — AppShell already persists the
 * dragged split to localStorage under `parley:shell`, so the collapsed flag
 * lives the same way rather than becoming app state the store has to migrate.
 *
 * Collapsing hides the panel outright instead of shrinking it to a sliver. A
 * collapsed-to-32px tree is a thing you have to aim at to get rid of, and the
 * saved split survives untouched, so re-expanding returns the width you had.
 */

const KEY = "parley:shell:sidebar-collapsed";

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = read();
const listeners = new Set<() => void>();

export function toggleSidebar(): void {
  collapsed = !collapsed;
  try {
    globalThis.localStorage?.setItem(KEY, collapsed ? "1" : "0");
  } catch {
    /* private mode / no storage — the toggle still works for this session */
  }
  for (const l of listeners) l();
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => collapsed,
    () => false
  );
}
