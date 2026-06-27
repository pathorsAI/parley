// Cloud folder CRUD over the public HTTP contract (see ./client). Personal folders
// mirror the local side-channel (../history/folders) to the cloud `folder` table
// when sync is on; org folders are server-authoritative (always read from cloud).
// This module is referenced ONLY inside CLOUD_ENABLED branches, so the OSS build
// tree-shakes it and the local-only edition makes no cloud calls.

import { cloudFetch, cloudToken, isAuthError, syncEnabled } from "./client";
import { log } from "../log";
import { listLocalFolders, type Folder } from "../history/folders";

/** A folder as the cloud knows it. `orgId` null = a personal folder. */
export interface CloudFolder {
  id: string;
  name: string;
  orgId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Personal folders (sync-gated) ─────────────────────────────────────────────

/** List the signed-in account's personal folders. [] when sync is off. */
export async function listCloudFolders(): Promise<CloudFolder[]> {
  if (!syncEnabled()) return [];
  const res = await cloudFetch("/folders");
  const data = (await res.json()) as { folders?: CloudFolder[] };
  return data.folders ?? [];
}

/** Create / idempotently re-sync a personal folder (keyed by its desktop id). */
export async function createCloudFolder(f: Folder): Promise<void> {
  if (!syncEnabled()) return;
  await cloudFetch("/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: f.id, name: f.name, createdAt: f.createdAt }),
  });
}

/** Rename a personal folder in the cloud. */
export async function renameCloudFolder(id: string, name: string): Promise<void> {
  if (!syncEnabled()) return;
  await cloudFetch(`/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** Delete a personal folder in the cloud (its recordings fall to the personal root). */
export async function deleteCloudFolder(id: string): Promise<void> {
  if (!syncEnabled()) return;
  await cloudFetch(`/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Push every local personal folder to the cloud (idempotent upserts). Run BEFORE
 * the recording sweep so the cloud knows all folders a synced recording might
 * reference. No-op when sync is off; bails on the first auth failure.
 */
export async function pushUnsyncedFolders(): Promise<void> {
  if (!syncEnabled()) return;
  for (const f of listLocalFolders()) {
    try {
      await createCloudFolder(f);
    } catch (e) {
      if (isAuthError(e)) break;
      log.warn("cloud: folder push failed", { id: f.id, error: String(e) });
    }
  }
}

// ── Org folders (membership-gated, always cloud) ──────────────────────────────

/** List an org's shared folders the signed-in user can see. [] when signed out. */
export async function listOrgFolders(orgId: string): Promise<CloudFolder[]> {
  if (!cloudToken()) return [];
  const res = await cloudFetch(`/orgs/${encodeURIComponent(orgId)}/folders`);
  const data = (await res.json()) as { folders?: CloudFolder[] };
  return data.folders ?? [];
}

/** Create a shared folder in an org (any member can). */
export async function createOrgFolder(orgId: string, name: string): Promise<CloudFolder> {
  const res = await cloudFetch(`/orgs/${encodeURIComponent(orgId)}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as { folder: CloudFolder };
  return data.folder;
}

/** Rename a shared folder (creator or org admin/owner). */
export async function renameOrgFolder(orgId: string, id: string, name: string): Promise<void> {
  await cloudFetch(`/orgs/${encodeURIComponent(orgId)}/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** Delete a shared folder (creator or org admin/owner); its recordings fall to root. */
export async function deleteOrgFolder(orgId: string, id: string): Promise<void> {
  await cloudFetch(`/orgs/${encodeURIComponent(orgId)}/folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Move an org-shared recording into a folder (or the org root with folderId null). */
export async function setOrgRecordingFolder(
  orgId: string,
  id: string,
  folderId: string | null,
): Promise<void> {
  await cloudFetch(
    `/orgs/${encodeURIComponent(orgId)}/recordings/${encodeURIComponent(id)}/folder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    },
  );
}
