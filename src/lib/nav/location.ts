import { nodeKey } from "../library/scope";
import type { LibrarySelection } from "../store";

/**
 * A PLACE in the main window, named the same way by everything that goes there
 * or remembers having been there (the ⌘K palette, the back/forward stack).
 *
 * Deliberately data, not behaviour: a location has to survive being put in a
 * list and replayed later, which rules out closing over a handler.
 *
 * Settings is absent on purpose — it is its own OS window (see ./settings.ts),
 * so it is never a place this window has "gone to" and never belongs in the
 * back stack.
 */
export type Location =
  | { kind: "home" }
  | { kind: "library"; selection: LibrarySelection }
  | { kind: "entry"; id: string };

/** Stable identity of a library selection. The org NAME is left out: renaming
 *  an org doesn't make its folder a different place. */
function selectionKey(selection: LibrarySelection): string {
  switch (selection.kind) {
    case "personal":
      return `personal:${nodeKey(selection.node)}`;
    case "org":
      return `org:${selection.id}:${selection.folderId ?? ""}`;
    case "voice":
      return "voice";
  }
}

/** Stable identity for comparison — two locations are the same place iff their
 *  keys match. */
export function locationKey(location: Location): string {
  switch (location.kind) {
    case "home":
      return "home";
    case "library":
      return `library:${selectionKey(location.selection)}`;
    case "entry":
      return `entry:${location.id}`;
  }
}

export function sameLocation(a: Location, b: Location): boolean {
  return locationKey(a) === locationKey(b);
}
