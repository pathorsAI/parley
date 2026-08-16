/**
 * Which node of the one tree a recording belongs to — ONE rule, used by both the
 * sidebar counts and the grid contents.
 *
 * This module exists because of the bug issue #195 is about. When the tree and
 * the grid each decided membership their own way, "和運租車 · 3 場" and the
 * three cards you saw after clicking it were two independent answers that
 * happened to agree most of the time. Now the number IS a count of exactly what
 * the click will show.
 *
 * A recording's node is its FOLDER, and nothing else. One customer, one folder.
 */

/** The minimum a recording has to expose to be placed in the tree. */
export interface FiledRecording {
  folderId?: string | null;
}

/** A node of the personal tree. Orgs keep their own folder-only rule below. */
export type LibraryNode =
  | { kind: "folder"; folderId: string }
  /** Not filed anywhere (or filed into a folder that has since been deleted). */
  | { kind: "unassigned" };

/** The folder facts `ownerNode` needs, prepared once per render. */
export interface OwnershipIndex {
  /** Every live personal folder id. */
  folders: ReadonlySet<string>;
}

export interface FolderRef {
  id: string;
}

export function buildOwnershipIndex(folders: readonly FolderRef[]): OwnershipIndex {
  return { folders: new Set(folders.map((f) => f.id)) };
}

/** The one node `entry` belongs to. Total by construction: a folder id nothing
 *  answers to lands on `unassigned` rather than falling out of the tree. */
export function ownerNode(entry: FiledRecording, idx: OwnershipIndex): LibraryNode {
  const folderId = entry.folderId ?? null;
  if (folderId && idx.folders.has(folderId)) return { kind: "folder", folderId };
  return { kind: "unassigned" };
}

/** Stable identity for a node — for map keys and selection comparison. */
export function nodeKey(node: LibraryNode): string {
  return node.kind === "folder" ? `f:${node.folderId}` : "unassigned";
}

export function sameNode(a: LibraryNode, b: LibraryNode): boolean {
  return nodeKey(a) === nodeKey(b);
}

/** Is `entry` on `node`? The grid filter. */
export function inNode(entry: FiledRecording, node: LibraryNode, idx: OwnershipIndex): boolean {
  return sameNode(ownerNode(entry, idx), node);
}

/** Every node's recording count in one pass, keyed by {@link nodeKey} — the
 *  sidebar draws hundreds of rows off one traversal, and each count is a count
 *  of exactly what clicking that row opens. */
export function countByNode(
  entries: readonly FiledRecording[],
  idx: OwnershipIndex
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = nodeKey(ownerNode(e, idx));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Everything filed in one folder — the folder's own recording list. */
export function recordingsOfFolder<T extends FiledRecording>(
  entries: readonly T[],
  folderId: string,
  idx: OwnershipIndex
): T[] {
  return entries.filter((e) => inNode(e, { kind: "folder", folderId }, idx));
}

/** One same-name folder group the dedupe migration should merge. */
export interface FolderMerge {
  /** The folder that survives. */
  canonicalId: string;
  /** Folders whose recordings move to the canonical, then get deleted. */
  twinIds: string[];
  name: string;
}

export interface DedupeFolderRef {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * Which same-name personal folders to merge, and into which survivor.
 *
 * The registry can genuinely hold two folders per name: the pre-file registry
 * era let a dev and a packaged instance each mint their own ids, and the cloud
 * mirror kept both (see the history/folders.ts header). The twin then lives on,
 * shows up beside its sibling in every folder list, and splits one customer's
 * recordings across two ids. The oldest of a group survives.
 */
export function planFolderDedupe(folders: readonly DedupeFolderRef[]): FolderMerge[] {
  const byName = new Map<string, DedupeFolderRef[]>();
  for (const f of folders) {
    const key = f.name.trim();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), f]);
  }
  const merges: FolderMerge[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const canonical = [...group].sort((a, b) => a.createdAt - b.createdAt)[0];
    merges.push({
      canonicalId: canonical.id,
      twinIds: group.filter((f) => f.id !== canonical.id).map((f) => f.id),
      name,
    });
  }
  return merges;
}

// ── Org scope ───────────────────────────────────────────────────────────────

/**
 * Is `entry` in the folder `folderId` of an ORG scope?
 *
 * `folderId === null` is the org root and takes everything with no folder PLUS
 * everything whose folder isn't in `liveFolderIds` — a recording tagged with a
 * folder that was deleted must land somewhere visible rather than vanish.
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
