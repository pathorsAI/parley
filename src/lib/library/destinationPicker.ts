import {
  PERSONAL_ROOT,
  sameDestination,
  serializeDestination,
  parseDestination,
  type LibraryDestination,
} from "./destination";

/**
 * The decisions behind the destination sheet (components/DestinationSheet),
 * kept pure so each one can be pinned down in a test: which workspace control
 * to draw, what the sheet opens on, how a place is spelled, what the primary
 * button says, and when to warn that other people will see the recording.
 *
 * A workspace is "Personal" or one org the user belongs to. Moving between
 * them is the same act as moving between folders — one picker, one button.
 */

/** The workspace key for Personal; an org's key is its id. */
export const PERSONAL_WORKSPACE = "personal";

export interface WorkspaceRef {
  id: string;
  name: string;
}

export interface NamedFolder {
  id: string;
  name: string;
}

/** The workspace a destination sits in. */
export function workspaceOf(d: LibraryDestination): string {
  return d.scope === "personal" ? PERSONAL_WORKSPACE : d.orgId;
}

/** The root of a workspace — "no folder". */
export function workspaceRoot(workspace: string): LibraryDestination {
  return workspace === PERSONAL_WORKSPACE
    ? PERSONAL_ROOT
    : { scope: "org", orgId: workspace, folderId: null };
}

/** A folder (or the root, for null) inside a workspace. */
export function inWorkspace(workspace: string, folderId: string | null): LibraryDestination {
  return workspace === PERSONAL_WORKSPACE
    ? { scope: "personal", folderId }
    : { scope: "org", orgId: workspace, folderId };
}

/**
 * Segmented control while every workspace fits on one row; a searchable
 * combobox past that. `count` includes Personal.
 */
export const SEGMENTED_MAX = 3;
export function workspaceControl(count: number): "segmented" | "combobox" {
  return count <= SEGMENTED_MAX ? "segmented" : "combobox";
}

/** A folder list is long enough to need a search field. */
export const SEARCH_THRESHOLD = 8;
export function needsFolderSearch(folderCount: number): boolean {
  return folderCount >= SEARCH_THRESHOLD;
}

/** Case-, width- and accent-insensitive key for folder search. */
function searchKey(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Folders whose name contains the query. A blank query keeps them all. */
export function filterFolders<F extends NamedFolder>(folders: readonly F[], query: string): F[] {
  const q = searchKey(query);
  if (!q) return [...folders];
  return folders.filter((f) => searchKey(f.name).includes(q));
}

/** A typed name that no folder already carries — the create row's trigger. */
export function canCreateFolder(folders: readonly NamedFolder[], query: string): boolean {
  const q = searchKey(query);
  return q.length > 0 && !folders.some((f) => searchKey(f.name) === q);
}

/** A destination still points at something that exists in this picker.
 *  `orgs === null` means the org list has not loaded yet: give it the benefit
 *  of the doubt rather than snapping to Personal and back. */
function resolvable(d: LibraryDestination, orgs: readonly WorkspaceRef[] | null): boolean {
  return d.scope === "personal" || orgs === null || orgs.some((o) => o.id === d.orgId);
}

/**
 * What the sheet opens on: the recording's current location, else (for a new
 * recording) the last place the user sent one, else the personal root. A
 * destination in an org the user can no longer reach falls through.
 */
export function initialDestination(
  current: LibraryDestination | null,
  lastUsed: LibraryDestination | null,
  orgs: readonly WorkspaceRef[] | null
): LibraryDestination {
  if (current && resolvable(current, orgs)) return current;
  if (lastUsed && resolvable(lastUsed, orgs)) return lastUsed;
  return PERSONAL_ROOT;
}

export interface CrumbNames {
  personal: string;
  orgs: readonly WorkspaceRef[];
  /** Folders of the destination's workspace, when known. */
  folders: readonly NamedFolder[];
}

/**
 * A place as its crumbs: `[個人]`, `[個人, 客戶會議]`, `[Pathors, 客戶會議]`.
 * A folder whose name is not known (yet) is left out rather than shown as an
 * id, and so is the root — a workspace alone already means "no folder".
 */
export function breadcrumb(d: LibraryDestination, names: CrumbNames): string[] {
  const head =
    d.scope === "personal"
      ? names.personal
      : (names.orgs.find((o) => o.id === d.orgId)?.name ?? "");
  const folder = d.folderId ? names.folders.find((f) => f.id === d.folderId)?.name : undefined;
  return [head, folder].filter((s): s is string => !!s);
}

export const CRUMB_SEPARATOR = " › ";
export function formatBreadcrumb(crumbs: readonly string[]): string {
  return crumbs.join(CRUMB_SEPARATOR);
}

/**
 * What the primary button does. `verb` is the caller's action: "move" an
 * existing recording, "save" a new one, or set the "share" default. A pick
 * equal to where the recording already is does nothing, so it says so instead
 * of offering a no-op. Picking Personal for the auto-share default means
 * "don't share".
 */
export type DestinationVerb = "move" | "save" | "share";
export type PrimaryAction =
  | { kind: "move" | "save" | "share"; target: string }
  | { kind: "stay"; target: string }
  | { kind: "shareOff" };

export function primaryAction(
  verb: DestinationVerb,
  current: LibraryDestination | null,
  selected: LibraryDestination,
  target: string
): PrimaryAction {
  if (verb === "share" && selected.scope === "personal") return { kind: "shareOff" };
  if (current && sameDestination(current, selected)) return { kind: "stay", target };
  return { kind: verb, target };
}

/**
 * Does this pick put the recording in front of other people who could not see
 * it before? True when it lands in an org it is not already in.
 */
export function revealsToOrg(
  current: LibraryDestination | null,
  selected: LibraryDestination
): boolean {
  if (selected.scope !== "org") return false;
  return !(current?.scope === "org" && current.orgId === selected.orgId);
}

/**
 * Only a personal recording heading into an org can keep a personal copy —
 * that is the share-vs-move choice, now one checkbox instead of a dialog.
 */
export function offersKeepCopy(
  current: LibraryDestination | null,
  selected: LibraryDestination
): boolean {
  return selected.scope === "org" && current?.scope !== "org";
}

// ── Last-used destination ────────────────────────────────────────────────────

const LAST_KEY = "parley:lastDestination";

/** The last place a recording was sent from a picker, for new recordings. */
export function loadLastDestination(storage: Pick<Storage, "getItem"> | null = safeStorage()):
  LibraryDestination | null {
  const raw = storage?.getItem(LAST_KEY);
  return raw ? parseDestination(raw) : null;
}

export function saveLastDestination(
  d: LibraryDestination,
  storage: Pick<Storage, "setItem"> | null = safeStorage()
): void {
  try {
    storage?.setItem(LAST_KEY, serializeDestination(d));
  } catch {
    /* storage full or unavailable — remembering is a convenience */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
