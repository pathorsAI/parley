// The best-effort cloud copy of a saved entry, refreshed after every local write.

import { markDirty } from "../cloud/syncState";
import { syncEnabled } from "../cloud/client";

/** Fire-and-forget cloud push (gated by the sync toggle); save paths stay simple. */
export async function pushToCloud(id: string): Promise<void> {
  // Content changed → flag dirty even when sync is off, so flipping sync ON later
  // makes the background sweep push this entry. pushLocalEntry clears dirty on a
  // confirmed push.
  markDirty(id);
  // Sync toggle off (or signed out / OSS) → don't push now; the sweep handles it
  // when sync is turned on. This is the save-time half of the syncEnabled chokepoint.
  if (!syncEnabled()) return;
  const sync = await import("../cloud/sync");
  await sync.pushLocalEntrySafe(id);
}
