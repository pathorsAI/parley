/**
 * Which node of the one tree a recording belongs to — ONE rule, used by both the
 * sidebar counts and the grid contents.
 *
 * This module exists because of the bug issue #195 is about. When the tree and
 * the grid each decided membership their own way, "和運租車 · 3 場" and the
 * three cards you saw after clicking it were two independent claims that
 * happened to agree most of the time. Now the number IS a count of exactly what
 * the click will show.
 *
 * Ownership is the CUSTOMER, not the folder. Splitting it across two fields is
 * what made "客戶跟資料夾是兩套東西" true no matter how the tree was drawn:
 * linking a recording to a company after the fact wrote `companyId` and left
 * `folderId` alone, so the company page listed it while the company's own tree
 * node could never count it. `folderId` is now just where the file sits on disk
 * (and what the cloud folder mirror syncs); the only thing that decides whose
 * recording this is, is `companyId`.
 *
 * `folderId` survives here in exactly one role: a FALLBACK for recordings saved
 * before the link existed. A recording sitting in a company's paired folder with
 * no `companyId` reads as that company's — otherwise every pre-#211 recording
 * would appear to have lost its customer overnight.
 */

/** The minimum a recording has to expose to be placed in the tree. */
export interface FiledRecording {
  companyId?: string | null;
  folderId?: string | null;
}

/** A node of the personal tree. Orgs keep their own folder-only rule below. */
export type LibraryNode =
  | { kind: "company"; companyId: string }
  /** A folder belonging to no company — legacy filing, kept reachable. */
  | { kind: "folder"; folderId: string }
  /** No customer (and no legacy folder that implies one). */
  | { kind: "unassigned" };

/** The company/folder facts `ownerNode` needs, prepared once per render. */
export interface OwnershipIndex {
  /** Every known company id — archived included: an archived customer still
   *  owns its past calls, and dropping them would look like data loss. */
  companies: ReadonlySet<string>;
  /** folderId → the company that owns it (`Company.folderId`). */
  folderOwner: ReadonlyMap<string, string>;
  /** Live folders owned by no company. */
  looseFolders: ReadonlySet<string>;
}

export interface CompanyRef {
  id: string;
  folderId?: string | null;
}
export interface FolderRef {
  id: string;
}

export function buildOwnershipIndex(
  companies: readonly CompanyRef[],
  folders: readonly FolderRef[]
): OwnershipIndex {
  const folderOwner = new Map<string, string>();
  const companyIds = new Set<string>();
  for (const c of companies) {
    companyIds.add(c.id);
    if (c.folderId) folderOwner.set(c.folderId, c.id);
  }
  const looseFolders = new Set<string>();
  for (const f of folders) if (!folderOwner.has(f.id)) looseFolders.add(f.id);
  return { companies: companyIds, folderOwner, looseFolders };
}

/** The one node `entry` belongs to. Total by construction: anything that
 *  matches nothing lands on `unassigned` rather than falling out of the tree. */
export function ownerNode(entry: FiledRecording, idx: OwnershipIndex): LibraryNode {
  const companyId = entry.companyId ?? null;
  // A link to a company that no longer exists falls through to the folder rule
  // (and then to unassigned) — never to a node the tree doesn't draw.
  if (companyId && idx.companies.has(companyId)) return { kind: "company", companyId };
  const folderId = entry.folderId ?? null;
  if (folderId) {
    const owner = idx.folderOwner.get(folderId);
    if (owner) return { kind: "company", companyId: owner };
    if (idx.looseFolders.has(folderId)) return { kind: "folder", folderId };
  }
  return { kind: "unassigned" };
}

/** Stable identity for a node — for map keys and selection comparison. */
export function nodeKey(node: LibraryNode): string {
  if (node.kind === "company") return `c:${node.companyId}`;
  if (node.kind === "folder") return `f:${node.folderId}`;
  return "unassigned";
}

export function sameNode(a: LibraryNode, b: LibraryNode): boolean {
  return nodeKey(a) === nodeKey(b);
}

/** Is `entry` on `node`? The grid filter. */
export function inNode(
  entry: FiledRecording,
  node: LibraryNode,
  idx: OwnershipIndex
): boolean {
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

/**
 * Everything belonging to one customer — the company page's meeting list and
 * pre-flight's "第 N 次" both run through here.
 *
 * They used to filter on `entry.companyId` directly, which meant a recording
 * only the FALLBACK can place (filed in the company's folder before links
 * existed, or a cloud-only card whose summary carries no link) showed in the
 * tree but not on the company's own page — the same two-answers split, one
 * layer down.
 */
export function recordingsOfCompany<T extends FiledRecording>(
  entries: readonly T[],
  companyId: string,
  idx: OwnershipIndex
): T[] {
  const node: LibraryNode = { kind: "company", companyId };
  return entries.filter((e) => inNode(e, node, idx));
}

/**
 * The customer this entry should have written on it, or null when it already
 * agrees with the rule. Drives the one-shot upgrade backfill: the read fallback
 * places these correctly in the tree, but anything reading `companyId` straight
 * off the record (the cloud summary row, an MCP client, a future feature) still
 * sees an unowned recording until the field itself is fixed.
 */
export function ownerBackfill(entry: FiledRecording, idx: OwnershipIndex): string | null {
  if (entry.companyId) return null;
  const folderId = entry.folderId ?? null;
  if (!folderId) return null;
  return idx.folderOwner.get(folderId) ?? null;
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
 * mirror kept both (see the history/folders.ts header). ensureCompanyFolder
 * then adopts ONE of them by name — the twin lives on, shows up beside it in
 * every folder list, and splits the company's recordings across two ids.
 *
 * The survivor is the company-paired folder when the group has exactly one;
 * otherwise the oldest. A group where SEVERAL companies claim folders of the
 * same name is skipped outright — that's two same-named companies, and merging
 * their filing on a name match would move recordings between customers.
 */
export function planFolderDedupe(
  folders: readonly DedupeFolderRef[],
  companies: readonly CompanyRef[]
): FolderMerge[] {
  const paired = new Set(
    companies.map((c) => c.folderId).filter((id): id is string => !!id)
  );
  const byName = new Map<string, DedupeFolderRef[]>();
  for (const f of folders) {
    const key = f.name.trim();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), f]);
  }
  const merges: FolderMerge[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const pairedInGroup = group.filter((f) => paired.has(f.id));
    if (pairedInGroup.length > 1) continue; // two same-named companies — hands off
    const canonical =
      pairedInGroup[0] ?? [...group].sort((a, b) => a.createdAt - b.createdAt)[0];
    merges.push({
      canonicalId: canonical.id,
      twinIds: group.filter((f) => f.id !== canonical.id).map((f) => f.id),
      name,
    });
  }
  return merges;
}

// ── Org scope ───────────────────────────────────────────────────────────────
// A shared org has folders and no companies, so its tree keeps the plain
// folder rule. Nothing here is used by the personal tree.

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
