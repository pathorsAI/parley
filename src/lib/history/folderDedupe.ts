// Startup repair: merge same-name personal folder twins.

import { log } from "../log";
import { isTauri } from "../tauriEvents";
import { CLOUD_ENABLED } from "../flags";
import { planFolderDedupe } from "../library/scope";
import { deleteCloudFolder } from "../cloud/folders";
import { deleteLocalFolder, emitFoldersUpdated, listLocalFolders } from "./folders";
import { emitHistoryUpdated, listHistory, rewriteEntry } from "./entryStore";

/** Refile one saved recording onto the surviving folder. Returns false when the
 *  entry couldn't be rewritten — logged, never fatal: the sweep goes on. */
async function repointEntryFolder(id: string, target: string): Promise<boolean> {
  try {
    await rewriteEntry(id, (meta) => ({ ...meta, folderId: target }));
    return true;
  } catch (e) {
    log.warn("history: folder dedupe failed for entry", { id, error: String(e) });
    return false;
  }
}

/** Refile every recording filed in a twin folder onto its survivor. `swept` is
 *  false when the pass itself failed, so the twins must be kept for now. */
async function repointRecordings(
  survivorOf: ReadonlyMap<string, string>,
): Promise<{ moved: number; swept: boolean }> {
  let moved = 0;
  try {
    for (const summary of await listHistory()) {
      const target = summary.folderId ? survivorOf.get(summary.folderId) : undefined;
      if (!target) continue;
      if (await repointEntryFolder(summary.id, target)) moved++;
    }
  } catch (e) {
    log.warn("history: folder dedupe sweep failed", { error: String(e) });
    return { moved, swept: false };
  }
  return { moved, swept: true };
}

/**
 * Merge same-name personal folder twins.
 *
 * The plan comes from {@link planFolderDedupe} (see its comment for how the
 * twins came to exist). This applies it: repoint every recording filed in a
 * twin onto the survivor, delete the twins locally, and delete them in the
 * cloud so the mirror-down in reloadFolders doesn't resurrect them next
 * launch. When sync is off the cloud delete no-ops and the twins WILL come
 * back from the mirror after sign-in — which is fine, because this runs every
 * startup and converges the next time around.
 *
 * Idempotent, no flag, no cloud push of entries (a push re-uploads audio).
 */
export async function migrateDuplicateFolders(): Promise<number> {
  if (!isTauri()) return 0;
  const merges = planFolderDedupe(listLocalFolders());
  if (!merges.length) return 0;
  const survivorOf = new Map<string, string>();
  for (const m of merges) for (const twin of m.twinIds) survivorOf.set(twin, m.canonicalId);

  const { moved, swept } = await repointRecordings(survivorOf);
  // A sweep that blew up may have left recordings on a twin — leave the twins in
  // place; the next startup runs this again and converges.
  if (!swept) return moved;

  // Recordings are safely off the twins — now the twins can go.
  for (const [twin] of survivorOf) {
    deleteLocalFolder(twin);
    if (CLOUD_ENABLED) {
      deleteCloudFolder(twin).catch((e) =>
        log.warn("history: twin folder cloud delete failed", { twin, error: String(e) })
      );
    }
  }
  await emitFoldersUpdated().catch(() => {});
  if (moved) await emitHistoryUpdated();
  log.info("history: folder dedupe complete", {
    merged: merges.map((m) => ({ name: m.name, twins: m.twinIds.length })),
    movedRecordings: moved,
  });
  return moved;
}
