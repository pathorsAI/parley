import {
  createLocalFolder,
  emitFoldersUpdated,
  listLocalFolders,
  renameLocalFolder,
} from "../history/folders";
import { createCloudFolder, renameCloudFolder } from "../cloud/folders";
import { useAccounts } from "./store";
import { log } from "../log";
import type { Company } from "./types";

/**
 * Company ↔ history-folder pairing (issue #132): every company owns a personal
 * folder, created with the company and following its renames, so linked
 * meetings file themselves under the customer. Deleting/archiving a company
 * deliberately leaves the folder alone. Mirrors HistoryApp's creation pattern:
 * local first, cloud push best-effort (pushUnsyncedFolders retries offline).
 */

/** The company's folder id, or null when unlinked / the folder was deleted. */
export function companyFolderId(companyId: string | null): string | null {
  if (!companyId) return null;
  const company = useAccounts.getState().companies.find((c) => c.id === companyId);
  const fid = company?.folderId ?? null;
  return fid && listLocalFolders().some((f) => f.id === fid) ? fid : null;
}

/** Make sure `company` has a live folder: keep a valid pairing, adopt an
 *  existing folder with the exact same name, or create one. */
export function ensureCompanyFolder(company: Company): string {
  const folders = listLocalFolders();
  if (company.folderId && folders.some((f) => f.id === company.folderId)) {
    return company.folderId;
  }
  const adopted = folders.find((f) => f.name === company.name);
  const folder = adopted ?? createLocalFolder(company.name);
  if (!adopted) {
    createCloudFolder(folder).catch((e) =>
      log.warn("accounts: company folder cloud push failed", { error: String(e) })
    );
    void emitFoldersUpdated();
  }
  useAccounts.getState().updateCompany(company.id, { folderId: folder.id });
  log.info("accounts: company folder paired", {
    company: company.name,
    folderId: folder.id,
    adopted: !!adopted,
  });
  return folder.id;
}

/** Follow a company rename onto its folder — but only while the folder still
 *  carries the company's (old) name; a user-customized folder name wins.
 *  Call BEFORE the company record itself is renamed. */
export function renameCompanyFolder(company: Company, newName: string): void {
  const fid = company.folderId;
  if (!fid || !newName.trim() || newName === company.name) return;
  const folder = listLocalFolders().find((f) => f.id === fid);
  if (!folder || folder.name !== company.name) return;
  renameLocalFolder(fid, newName);
  renameCloudFolder(fid, newName).catch((e) =>
    log.warn("accounts: company folder cloud rename failed", { error: String(e) })
  );
  void emitFoldersUpdated();
}

/** Startup migration: pair every active company that predates this feature. */
export function migrateCompanyFolders(): void {
  const companies = useAccounts.getState().companies.filter((c) => !c.archived);
  for (const company of companies) {
    try {
      ensureCompanyFolder(company);
    } catch (e) {
      log.warn("accounts: folder migration failed for company", {
        company: company.name,
        error: String(e),
      });
    }
  }
}
