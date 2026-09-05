import { sameLocation, type Location } from "./location";

/**
 * Browser-style back/forward over {@link Location}s.
 *
 * The stack records where the app actually WENT, never where it was asked to
 * go — see {@link NavApply}. That distinction is the whole reason this module
 * takes its applier as a parameter instead of calling navigateTo directly: it
 * keeps the traversal rules (below) provable without a store, a window or a
 * Tauri backend.
 */

/**
 * What replaying a location did.
 *
 * `refused` and `unavailable` are NOT the same failure, and conflating them
 * breaks the stack in one of two ways:
 *   • `refused` — the app declined to move at all (a running meeting owns the
 *     window). Nothing is wrong with the location; it will be reachable again
 *     in a minute. A traversal stops and leaves the stack exactly as it was.
 *   • `unavailable` — the place is gone (the recording was deleted). It can
 *     never be reached again, so it is DROPPED from the stack and the traversal
 *     keeps walking. Skipping without dropping would leave a dead entry that
 *     every future ⌘[ has to trip over again.
 */
export type NavStatus = "applied" | "refused" | "unavailable";

export type NavApply = (location: Location) => Promise<NavStatus>;

/** Outcome of a back/forward press. `skipped` counts locations that turned out
 *  to be gone — the caller may want to say so rather than let the app appear to
 *  jump two steps. */
export interface TraversalResult {
  moved: boolean;
  skipped: number;
}

export interface NavHistoryOptions {
  apply: NavApply;
  /** Oldest entries fall off past this. A session left open for a week must not
   *  grow the stack without bound. */
  limit?: number;
}

export interface NavHistory {
  /** Record a location the app has ALREADY arrived at (a fresh navigation, not
   *  a traversal). Truncates whatever was ahead, like a browser. */
  record: (location: Location) => void;
  back: () => Promise<TraversalResult>;
  forward: () => Promise<TraversalResult>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  /** Introspection for tests and diagnostics. */
  entries: () => readonly Location[];
  current: () => Location | null;
  reset: () => void;
}

const DEFAULT_LIMIT = 50;

export function createNavHistory({ apply, limit = DEFAULT_LIMIT }: NavHistoryOptions): NavHistory {
  let stack: Location[] = [];
  /** Index of where we are now; -1 while the stack is empty. */
  let index = -1;
  /** A traversal is async (loading a recording hits disk). Two overlapping ones
   *  would interleave their index updates and land somewhere neither asked for,
   *  which is exactly what holding ⌘[ down produces. */
  let traversing = false;

  function record(location: Location): void {
    // Re-selecting the place you are already on is not a step. Without this,
    // clicking the same folder twice buries the real previous place under a
    // duplicate that ⌘[ then "goes back" to with no visible effect.
    if (index >= 0 && sameLocation(stack[index], location)) return;
    stack = stack.slice(0, index + 1);
    stack.push(location);
    if (stack.length > limit) stack = stack.slice(stack.length - limit);
    index = stack.length - 1;
  }

  async function traverse(direction: -1 | 1): Promise<TraversalResult> {
    if (traversing) return { moved: false, skipped: 0 };
    traversing = true;
    let skipped = 0;
    try {
      for (;;) {
        const next = index + direction;
        if (next < 0 || next >= stack.length) return { moved: false, skipped };
        const status = await apply(stack[next]);
        if (status === "applied") {
          index = next;
          return { moved: true, skipped };
        }
        if (status === "refused") return { moved: false, skipped };
        // Gone: drop it and keep walking the same direction. Going back, the
        // hole is BEHIND the cursor, so the cursor slides down with it.
        stack.splice(next, 1);
        if (direction === -1) index = next;
        skipped += 1;
      }
    } finally {
      traversing = false;
    }
  }

  return {
    record,
    back: () => traverse(-1),
    forward: () => traverse(1),
    canGoBack: () => index > 0,
    canGoForward: () => index < stack.length - 1,
    entries: () => stack,
    current: () => (index >= 0 ? stack[index] : null),
    reset: () => {
      stack = [];
      index = -1;
      traversing = false;
    },
  };
}
