// Pins on org-shared folders. Personal pins ride on the folder registry
// (Folder.pinnedAt); an org folder has no local registry entry to carry one,
// and a pin is a personal preference anyway, not something to push onto the
// whole org's folder table. So they live here: local-only, in localStorage,
// as { "${orgId}:${folderId}": pinnedAt }, with a tiny subscribe/notify so the
// sidebar re-renders when one changes.

import { useSyncExternalStore } from "react";
import { orgFolderKey, safeStorage } from "./folderRank";

const PINS_KEY = "parley:org-folder-pins";

export type OrgFolderPins = Readonly<Record<string, number>>;

type PinStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY: OrgFolderPins = Object.freeze({});

/** Read the pins. Empty on a missing or unreadable record. */
export function readOrgFolderPins(storage: PinStorage | null = safeStorage()): OrgFolderPins {
  try {
    const raw = storage?.getItem(PINS_KEY);
    if (!raw) return EMPTY;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return EMPTY;
    const out: Record<string, number> = {};
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at === "number") out[k] = at;
    }
    return out;
  } catch {
    return EMPTY;
  }
}

/** When this org folder was pinned, or undefined. */
export function orgFolderPinnedAt(
  pins: OrgFolderPins,
  orgId: string,
  folderId: string
): number | undefined {
  return pins[orgFolderKey(orgId, folderId)];
}

/**
 * Pin or unpin an org folder. Pinning one that is already pinned keeps its
 * original stamp, so it does not drop to the bottom of the pinned group.
 */
export function setOrgFolderPinned(
  orgId: string,
  folderId: string,
  pinned: boolean,
  now: number = Date.now(),
  storage: PinStorage | null = safeStorage()
): void {
  const key = orgFolderKey(orgId, folderId);
  const current = readOrgFolderPins(storage);
  if ((key in current) === pinned) return;
  const next: Record<string, number> = { ...current };
  if (pinned) next[key] = now;
  else delete next[key];
  try {
    storage?.setItem(PINS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or unavailable — the pin just doesn't stick */
  }
  notify();
}

// ── Subscription ────────────────────────────────────────────────────────────
// The snapshot is cached so useSyncExternalStore sees a stable object between
// changes (a fresh parse each call would re-render forever).

const listeners = new Set<() => void>();
let snapshot: OrgFolderPins | null = null;

function notify(): void {
  snapshot = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of this app writing the same key.
  const onStorage = (e: StorageEvent) => {
    if (e.key === PINS_KEY) notify();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

function getSnapshot(): OrgFolderPins {
  snapshot ??= readOrgFolderPins();
  return snapshot;
}

/** Every org folder pin, re-rendering the caller when one changes. */
export function useOrgFolderPins(): OrgFolderPins {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
