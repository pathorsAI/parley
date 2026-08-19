/**
 * WHERE a recording goes — the one answer every "which folder?" control produces.
 *
 * Before this type the pickers could only name a PERSONAL folder, so a user who
 * had joined an org could see its shared folders in the sidebar but had no way
 * to put a recording in one on the way in: the import doors and the after-the-
 * fact filing chips all spoke `string | null` (a personal folder id) and the org
 * side was reachable only from the library grid, and only into the org root.
 *
 * A destination is (scope, folder). The personal scope's folders come from the
 * local registry (../history/folders); an org's come from the server
 * (../cloud/folders). `folderId === null` is that scope's root.
 */

/**
 * What picking an ORG destination does to the personal original.
 *
 * The org model here is an explicit COPY — sharing never removes anything from
 * the personal library (see ../cloud/sync). "move" is the same copy followed by
 * deleting the personal original, which is what the library grid's
 * `moveRecordingToOrg` already does. The user is asked which one they meant,
 * rather than the picker guessing.
 */
export type OrgHandoffMode = "copy" | "move";

export type LibraryDestination =
  | { scope: "personal"; folderId: string | null }
  /** A folder (or the root) of an org the signed-in user belongs to. */
  | { scope: "org"; orgId: string; folderId: string | null };

/** The personal root — "not filed yet", and every picker's blank state. */
export const PERSONAL_ROOT: LibraryDestination = { scope: "personal", folderId: null };

export function personalDestination(folderId: string | null): LibraryDestination {
  return { scope: "personal", folderId: folderId ?? null };
}

/**
 * A destination as one combobox option value. `p` / `p:<folder>` for personal,
 * `o:<org>` / `o:<org>:<folder>` for an org — ids are uuids, so the first colon
 * after the prefix is an unambiguous separator.
 */
export function serializeDestination(d: LibraryDestination): string {
  if (d.scope === "personal") return d.folderId ? `p:${d.folderId}` : "p";
  return d.folderId ? `o:${d.orgId}:${d.folderId}` : `o:${d.orgId}`;
}

/** Inverse of {@link serializeDestination}. Anything unrecognised reads as the
 *  personal root rather than throwing — a stale option value must not wedge a
 *  picker. */
export function parseDestination(v: string): LibraryDestination {
  if (v.startsWith("o:")) {
    const rest = v.slice(2);
    const cut = rest.indexOf(":");
    if (cut === -1) return { scope: "org", orgId: rest, folderId: null };
    return { scope: "org", orgId: rest.slice(0, cut), folderId: rest.slice(cut + 1) };
  }
  if (v.startsWith("p:")) return { scope: "personal", folderId: v.slice(2) };
  return PERSONAL_ROOT;
}

export function sameDestination(a: LibraryDestination, b: LibraryDestination): boolean {
  return serializeDestination(a) === serializeDestination(b);
}
