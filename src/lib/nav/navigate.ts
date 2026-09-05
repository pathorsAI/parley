import { loadHistoryEntry } from "../history/history";
import { isMeetingActive, useStore } from "../store";
import { log } from "../log";
import { createNavHistory, type NavStatus } from "./history";
import { sameLocation, type Location } from "./location";

export type { Location } from "./location";
export { locationKey, sameLocation } from "./location";

/**
 * The ONE implementation of "go there".
 *
 * This started as `CommandPalette.activate`. It had to leave: back/forward
 * replays a location the same way the palette opened it, and two copies of that
 * switch would have drifted the first time a new kind of place was added.
 */

export interface NavOutcome {
  status: NavStatus;
  /** Only for `unavailable`: what the load actually failed with, so a caller
   *  that has somewhere to show it (the palette's toast) still can. */
  error?: unknown;
}

export interface NavigateOptions {
  /** Traversals pass false — replaying the back stack must not push onto it. */
  record?: boolean;
}

/**
 * Where the window is right now, as a {@link Location} — or null when it is
 * somewhere that isn't a destination (a live meeting, or an uploaded recording
 * that hasn't been saved and therefore has no id to come back to).
 */
export function currentLocation(): Location | null {
  const s = useStore.getState();
  switch (s.appMode) {
    case "home":
      return { kind: "home" };
    case "library":
      return { kind: "library", selection: s.librarySelection };
    case "study":
      return s.loadedHistoryId ? { kind: "entry", id: s.loadedHistoryId } : null;
    default:
      return null;
  }
}

/**
 * The window's back/forward stack. Only locations reached through
 * {@link navigateTo} are in it: a call site that sets `appMode` on the store
 * directly is invisible here, by design — the stack should hold places the user
 * chose to go, not every state the app passed through.
 */
export const navHistory = createNavHistory({
  apply: async (location) => (await navigateTo(location, { record: false })).status,
});

/**
 * Move the window to `location`, without touching the back stack.
 *
 * The two kinds are guarded differently, on purpose:
 *
 * `home` / `library` — `store.openHome` and `store.openLibrary` already refuse
 * silently while a meeting is running, so the verdict is read back off the
 * store AFTER the call instead of the rule being re-decided here. Restating the
 * guard would leave two copies to keep in sync, and a stack that records places
 * the app refused to go is worse than no stack at all.
 *
 * `entry` — the store's `loadHistory` has NO meeting guard: it would replace a
 * running meeting's transcript with the recording. Navigation holds that line
 * itself, before the load.
 */
async function applyLocation(location: Location): Promise<NavOutcome> {
  const store = useStore.getState();

  if (location.kind === "entry") {
    if (isMeetingActive(store.meetingStatus)) return { status: "refused" };
    try {
      // Switches the app to the study route itself.
      await loadHistoryEntry(location.id);
    } catch (error) {
      // Deleted, or unreadable — either way it is not somewhere we can be. The
      // back stack treats this as "drop it", so a recording removed mid-session
      // can't wedge ⌘[ on an entry that will never load again.
      log.warn("nav: entry unavailable", { id: location.id, error: String(error) });
      return { status: "unavailable", error };
    }
    return { status: "applied" };
  }

  if (location.kind === "home") store.openHome();
  else store.openLibrary(location.selection);

  const after = currentLocation();
  // This reads "the app IS where you asked", not "the app moved" — asking for
  // the place you are already standing counts as applied, which is what both
  // the palette and the stack want.
  return after && sameLocation(after, location) ? { status: "applied" } : { status: "refused" };
}

/** Go to `location`, record the trip, and report what happened. */
export async function navigateTo(
  location: Location,
  opts: NavigateOptions = {}
): Promise<NavOutcome> {
  const before = currentLocation();
  const outcome = await applyLocation(location);
  if (outcome.status === "applied" && opts.record !== false) {
    // Seed the stack with wherever we came from, once. Without it the first
    // jump of a session has nothing behind it and ⌘[ does nothing — the place
    // you started in is a place you were.
    if (navHistory.entries().length === 0 && before) navHistory.record(before);
    navHistory.record(location);
  }
  return outcome;
}
