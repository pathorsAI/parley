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

// ── The cockpit hold ─────────────────────────────────────────────────────────
//
// The live cockpit is never shown beside the tree. While a meeting runs the
// coach owns the window; once it stops, the cockpit is only ever on screen on
// its way out — to the report (the save opens it), or Home (a meeting too short
// or too empty to keep). Bringing the tree back in between turned the
// three-column coach into a four-column frame, then re-laid everything out
// again when the next screen arrived. It used to be held back only while the
// save was in flight, which left the four-column frame up whenever a meeting
// ended without a report; now it is held for as long as the stopped cockpit is
// on screen, whatever the save is doing.
//
// That can last (a long save, a failed one left up so its transcript is still
// readable), and it must not trap the user, so ⌘B during the hold PEEKS: it
// shows/hides the tree for this hold only, without touching the saved collapsed
// preference above. The peek resets when the hold ends (AppShell), so the next
// meeting starts hidden again.

/** The facts the shell's tree decision depends on, as plain values. */
export interface ShellTreeFacts {
  /** A meeting is recording or paused — the coach owns the window. */
  meetingActive: boolean;
  /** The live route (the cockpit) is what's on screen. */
  liveRoute: boolean;
  /** The saved ⌘B preference. */
  collapsed: boolean;
  /** The session-only ⌘B reveal during the cockpit hold. */
  peek: boolean;
}

/** Whether the cockpit hold applies: the meeting has stopped but its cockpit
 *  is still on screen. Leaving the live route (the report or Home opening, ⌘K,
 *  ⌘1…) ends the hold — there is no cockpit left to protect. */
export function cockpitHold(f: Pick<ShellTreeFacts, "meetingActive" | "liveRoute">): boolean {
  return !f.meetingActive && f.liveRoute;
}

/** Whether the left tree is on screen. Pure + exported for testing. */
export function shellTreeVisible(f: ShellTreeFacts): boolean {
  if (f.meetingActive) return false;
  if (cockpitHold(f)) return f.peek;
  return !f.collapsed;
}

let peek = false;
const peekListeners = new Set<() => void>();

function setPeek(next: boolean): void {
  if (peek === next) return;
  peek = next;
  for (const l of peekListeners) l();
}

/** ⌘B during the cockpit hold: show/hide the tree without saving anything. */
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
