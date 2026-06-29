// Personal folder definitions, kept in localStorage (shared across the app's
// same-origin webview windows, like ../cloud/syncState and ../settingsSync). This
// is the LOCAL source of truth for one-level personal folders, and it works with
// ZERO cloud — the OSS edition imports only this, never ../cloud/folders. When
// cloud sync is on, the History window mirrors these to the cloud `folder` table,
// but that lives in ../cloud/folders, referenced only inside CLOUD_ENABLED branches
// so the OSS build tree-shakes it.
//
// A recording's folder membership is NOT here — it rides on the entry's own
// meta.json (HistoryEntry.folderId). This file is only the folder list (ids+names).
// Folders are one level deep (no nesting). A folderId that no longer matches any
// folder here renders at the personal root (the orphan→root rule in HistoryApp).

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";

const KEY = "parley:folders";
const FOLDERS_UPDATED_EVENT = "history://folders-updated";

/** A one-level personal folder. `createdAt` (epoch ms) gives a stable order. */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

function read(): Folder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Folder[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(folders: Folder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(folders));
  } catch {
    /* quota / serialization — best effort */
  }
}

/** Personal folders, oldest first (stable sidebar order). */
export function listLocalFolders(): Folder[] {
  return read().sort((a, b) => a.createdAt - b.createdAt);
}

/** Replace the whole local folder cache — used to mirror the cloud list down so a
 *  folder created on another device shows here (and one deleted there disappears). */
export function writeLocalFolders(folders: Folder[]): void {
  write(folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })));
}

/** Create a personal folder locally and return it. */
export function createLocalFolder(name: string): Folder {
  const f: Folder = { id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() };
  write([...read(), f]);
  return f;
}

/** Rename a personal folder locally (no-op if missing). */
export function renameLocalFolder(id: string, name: string): void {
  write(read().map((f) => (f.id === id ? { ...f, name: name.trim() } : f)));
}

/** Delete a personal folder locally (the recordings it held fall to the root). */
export function deleteLocalFolder(id: string): void {
  write(read().filter((f) => f.id !== id));
}

/** Tell other windows the personal folder list changed (History grid, Settings picker). */
export async function emitFoldersUpdated(): Promise<void> {
  if (!isTauri()) return;
  await emit(FOLDERS_UPDATED_EVENT, {});
}

/** Listen for personal-folder changes broadcast from another window. */
export async function listenForFoldersUpdated(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen(FOLDERS_UPDATED_EVENT, () => cb());
}
