// The library screen's decisions, kept pure so each can be pinned in a test:
// how an org recording becomes a card, which empty state and delete wording a
// scope gets, where a card can move and what a move means, and what makes the
// open list a different list.

import type { TranslationKey } from "../../i18n/messages";
import type { LibrarySelection } from "../store";
import type { CloudRecordingSummary } from "../cloud/types";
import type { HistoryCardItem } from "../cloud/sync";
import { filingChoices, type Folder as LocalFolder } from "../history/folders";
import type { LibraryDestination, OrgHandoffMode } from "./destination";
import { nodeKey } from "./scope";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Map a cloud org recording to the card shape the list renders. */
export function orgCard(c: CloudRecordingSummary): HistoryCardItem {
  return {
    id: c.id,
    title: c.title,
    source: c.source,
    createdAt: c.createdAt,
    durationMs: c.durationMs,
    speakerCount: c.speakerCount,
    findingsCount: c.findingsCount,
    actionItemsCount: c.actionItemsCount,
    hasAudio: c.hasAudio,
    snippet: c.snippet,
    folderId: c.folderId ?? null,
    sync: "cloud",
    cloudUpdatedAt: c.updatedAt,
  };
}


/** The name of the folder the selection points at, or null at a scope root. */
export function openFolderName(selection: LibrarySelection, folders: LocalFolder[]): string | null {
  let id: string | null = null;
  if (selection.kind === "org") id = selection.folderId;
  else if (selection.kind === "personal" && selection.node.kind === "folder") {
    id = selection.node.folderId;
  }
  if (!id) return null;
  return folders.find((f) => f.id === id)?.name ?? null;
}

/** Which "nothing here" copy fits the open scope. */
export function emptyStateCopy(
  t: Translate,
  scope: Readonly<{ searching: boolean; hasFolder: boolean; isOrg: boolean; isAll: boolean }>
): { title: string; hint: string } {
  if (scope.searching) {
    return { title: t("history.searchEmpty"), hint: t("history.searchEmptyHint") };
  }
  if (scope.hasFolder) {
    return { title: t("history.folder.empty"), hint: t("history.folder.emptyHint") };
  }
  if (scope.isOrg) return { title: t("history.org.empty"), hint: t("history.org.emptyHint") };
  // Empty here means empty everywhere — there is no folder left to go and look in.
  if (scope.isAll) return { title: t("library.all.empty"), hint: t("library.all.emptyHint") };
  return { title: t("library.unassigned.empty"), hint: t("library.unassigned.emptyHint") };
}

/** The delete dialog's words: in an org scope the action is "remove from the
 *  org", everywhere else it is a delete. */
export function deleteDialogCopy(
  t: Translate,
  isOrg: boolean,
  title: string
): { title: string; body: string; confirmLabel: string } {
  if (isOrg) {
    return {
      title: t("history.org.remove"),
      body: t("history.org.removeConfirm", { title }),
      confirmLabel: t("history.org.remove"),
    };
  }
  return {
    title: t("history.delete"),
    body: t("history.deleteConfirm", { title }),
    confirmLabel: t("common.delete"),
  };
}

/**
 * Where a card in this scope can be MOVED, which is not the same list as what
 * exists: an archived personal folder is still a home for what is already in it,
 * but nothing new gets filed into one. The folder currently OPEN stays offered
 * even when archived, so a card sitting in it still shows the check beside its
 * own home. Org folders carry no archive state and pass straight through.
 */
export function moveTargetFolders(
  selection: LibrarySelection,
  scopeFolders: LocalFolder[]
): LocalFolder[] {
  if (selection.kind !== "personal") return scopeFolders;
  const open = selection.node.kind === "folder" ? selection.node.folderId : null;
  return filingChoices(scopeFolders, open);
}

/**
 * Which action a destination means for a card: a refile inside the open org,
 * a personal folder change, or a handoff into an org.
 */
export function routeFiling(
  inOrg: boolean,
  item: HistoryCardItem,
  destination: LibraryDestination,
  mode: OrgHandoffMode | null,
  actions: Readonly<{
    moveInOrg: (item: HistoryCardItem, folderId: string | null) => Promise<void>;
    move: (item: HistoryCardItem, folderId: string | null) => Promise<void>;
    handOffToOrg: (
      item: HistoryCardItem,
      orgId: string,
      folderId: string | null,
      mode: OrgHandoffMode
    ) => Promise<void>;
  }>
): Promise<void> {
  if (inOrg) return actions.moveInOrg(item, destination.folderId);
  if (destination.scope === "personal") return actions.move(item, destination.folderId);
  return actions.handOffToOrg(item, destination.orgId, destination.folderId, mode ?? "move");
}

/** Where a card lives: its folder in the open org, or in Personal. */
export function cardLocation(selection: LibrarySelection, item: HistoryCardItem): LibraryDestination {
  if (selection.kind === "org") return { scope: "org", orgId: selection.id, folderId: item.folderId ?? null };
  return { scope: "personal", folderId: item.folderId ?? null };
}

/** What the open list is a list OF — the scope, the node within it, the search.
 *  A change starts the render window (useRenderWindow) back on its first page. */
export function listKey(selection: LibrarySelection, searchQuery: string): string {
  let where = "";
  if (selection.kind === "org") where = `org:${selection.id}:${selection.folderId ?? ""}`;
  else if (selection.kind === "personal") where = `personal:${nodeKey(selection.node)}`;
  return `${where}|${searchQuery}`;
}
