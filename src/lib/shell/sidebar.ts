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

// ── The finalizing hold ──────────────────────────────────────────────────────
//
// Between End and the report opening (the recording is being encoded and
// written), the live cockpit is still on screen but the meeting is no longer
// running. Bringing the tree back right then turned the three-column coach into
// a four-column frame for the whole save, only to re-lay everything out again a
// few seconds later when the report replaced it. So the tree stays away until
// the report arrives: the layout changes exactly once.
//
// A save can still take minutes, and a long one must not trap the user, so ⌘B
// during the hold PEEKS: it shows/hides the tree for this hold only, without
// touching the saved collapsed preference above. The peek resets when the hold
// ends (AppShell), so the next meeting starts hidden again.

/** The facts the shell's tree decision depends on, as plain values. */
export interface ShellTreeFacts {
  /** A meeting is recording or paused — the coach owns the window. */
  meetingActive: boolean;
  /** End was pressed and the recording's first write hasn't landed yet. */
  finalizing: boolean;
  /** The live route (the cockpit) is what's on screen. */
  liveRoute: boolean;
  /** The saved ⌘B preference. */
  collapsed: boolean;
  /** The session-only ⌘B reveal during a finalizing hold. */
  peek: boolean;
}

/** Whether the finalizing hold applies: the cockpit is still up, the meeting
 *  has stopped, and its save hasn't opened the report yet. Leaving the live
 *  route (⌘K, ⌘1…) ends the hold — there is no cockpit left to protect. */
export function finalizingHold(f: Pick<ShellTreeFacts, "meetingActive" | "finalizing" | "liveRoute">): boolean {
  return !f.meetingActive && f.finalizing && f.liveRoute;
}

/** Whether the left tree is on screen. Pure + exported for testing. */
export function shellTreeVisible(f: ShellTreeFacts): boolean {
  if (f.meetingActive) return false;
  if (finalizingHold(f)) return f.peek;
  return !f.collapsed;
}

let peek = false;
const peekListeners = new Set<() => void>();

function setPeek(next: boolean): void {
  if (peek === next) return;
  peek = next;
  for (const l of peekListeners) l();
}

/** ⌘B during a finalizing hold: show/hide the tree without saving anything. */
export function toggleSidebarPeek(): void {
  setPeek(!peek);
}

/** Drop the peek — called when the hold ends, so it never outlives the save. */
export function resetSidebarPeek(): void {
  setPeek(false);
}

export function useSidebarPeek(): boolean {
  return useSyncExternalStore(
    (listener) => {
      peekListeners.add(listener);
      return () => peekListeners.delete(listener);
    },
    () => peek,
    () => false
  );
}
