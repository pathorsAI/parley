// Renaming the loaded recording from its titlebar crumb.

import { useStore } from "../store";

/** The title an inline rename should save, or null when there is nothing to
 *  save: an empty draft, an unchanged name, or a recording not in the local
 *  library (an unsaved upload or a read-only org recording). Pure. */
export function renameTarget(draft: string, currentName: string, loadedHistoryId: string | null): string | null {
  const clean = draft.trim();
  if (!clean || clean === currentName || !loadedHistoryId) return null;
  return clean;
}

/** Persist the rename (disk + cloud + other windows via renameHistoryEntry),
 *  then show it in the replay header at once. Rejects when the save fails. */
export async function renameLoadedRecording(id: string, title: string): Promise<void> {
  const { renameHistoryEntry } = await import("../history/history");
  await renameHistoryEntry(id, title);
  useStore.getState().renameReplay(title);
}
