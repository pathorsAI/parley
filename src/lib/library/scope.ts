/**
 * Which node of the tree a recording belongs to — ONE rule, used by both the
 * sidebar counts and the grid contents.
 *
 * This module exists because of the bug issue #195 is about. When the tree and
 * the grid each decided membership their own way, "和運租車 · 3 場" and the
 * three cards you saw after clicking it were two independent claims that
 * happened to agree most of the time. Now the number IS a count of exactly what
 * the click will show.
 */

/** The minimum a recording has to expose to be placed in the tree. */
export interface FiledRecording {
  folderId?: string | null;
}

/**
 * Is `entry` in the folder `folderId` of this scope?
 *
 * `folderId === null` is the scope's catch-all (未歸戶 / the org root) and takes
 * everything with no folder PLUS everything whose folder isn't in
 * `liveFolderIds` — a recording tagged with a folder that was deleted, or one
 * tagged for the other scope, must land somewhere visible rather than vanish.
 */
export function inFolderNode(
  entry: FiledRecording,
  folderId: string | null,
  liveFolderIds: ReadonlySet<string>
): boolean {
  const fid = entry.folderId ?? null;
  if (folderId === null) return fid === null || !liveFolderIds.has(fid);
  return fid === folderId;
}

/** How many of `entries` land on the folder node `folderId`. */
export function countInFolderNode(
  entries: readonly FiledRecording[],
  folderId: string | null,
  liveFolderIds: ReadonlySet<string>
): number {
  let n = 0;
  for (const e of entries) if (inFolderNode(e, folderId, liveFolderIds)) n++;
  return n;
}
