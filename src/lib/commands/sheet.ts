import { useSyncExternalStore } from "react";

/**
 * Whether the ⇧? cheat sheet is up, for this window.
 *
 * Deliberately NOT a field on the app store: the sheet has to work in Settings
 * and the Field Log too, and those windows have no business carrying the
 * meeting/replay state that store is made of. A module-level boolean is the
 * whole requirement.
 */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleShortcutSheet(): void {
  open = !open;
  emit();
}

export function closeShortcutSheet(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useShortcutSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    // Server snapshot: never rendered outside a browser, but React 19 asks.
    () => false
  );
}
