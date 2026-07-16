// Personal folder definitions. The source of truth is a SHARED CONFIG FILE
// (`folders.json` in the app config dir, via read_folders/write_folders) — one
// registry for every window AND every app instance. The old registry lived in
// localStorage, which is per-webview-origin: a packaged app (tauri://localhost)
// and `tauri dev` (http://localhost:1420) each kept their own copy while the
// recordings' folderIds live in shared on-disk meta — running both at once let
// the cloud folder mirror ping-pong two divergent id sets and orphan every
// filed recording. The disk registry ends that fork by construction.
//
// Reads stay SYNCHRONOUS via an in-memory cache hydrated once per window
// (initFolderRegistry, called from main.tsx). localStorage is kept as the
// pre-hydration fallback, the browser(-dev) backend, and a downgrade-safe
// mirror. This module works with ZERO cloud — the OSS edition imports only
// this, never ../cloud/folders. When cloud sync is on, the History window
// mirrors the registry to the cloud `folder` table (../cloud/folders inside
// CLOUD_ENABLED branches only).
//
// A recording's folder membership is NOT here — it rides on the entry's own
// meta.json (HistoryEntry.folderId). This file is only the folder list (ids+names).
// Folders are one level deep (no nesting). A folderId that no longer matches any
// folder here renders at the personal root (the orphan→root rule in HistoryApp).

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { log } from "../log";

const KEY = "parley:folders";
const FOLDERS_UPDATED_EVENT = "history://folders-updated";

/** A one-level personal folder. `createdAt` (epoch ms) gives a stable order. */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

/** Hydrated registry (null until initFolderRegistry / the first refresh). */
let cache: Folder[] | null = null;

function parseFolders(raw: string | null): Folder[] | null {
  try {
    const v = JSON.parse(raw ?? "[]") as Folder[];
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function readLocalStorage(): Folder[] {
  try {
    return parseFolders(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

function writeLocalStorage(folders: Folder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(folders));
  } catch {
    /* quota / serialization — best effort */
  }
}

function read(): Folder[] {
  // Pre-hydration (or browser dev, where hydration is a no-op): localStorage
  // is the best available answer and matches the pre-file behaviour.
  return cache ?? readLocalStorage();
}

/** Commit a new registry: cache (sync reads), disk (the truth), localStorage
 *  (browser backend + downgrade safety). */
function persist(folders: Folder[]): void {
  cache = folders;
  writeLocalStorage(folders);
  if (isTauri()) {
    invoke("write_folders", { json: JSON.stringify(folders) }).catch((e) =>
      log.error("folders: registry write failed", { error: String(e) })
    );
  }
}

/** Re-read the on-disk registry into the cache (no-op outside Tauri). */
async function refreshFromDisk(): Promise<void> {
  if (!isTauri()) return;
  try {
    const raw = await invoke<string>("read_folders");
    if (raw.trim()) {
      const v = parseFolders(raw);
      if (v) cache = v;
    }
  } catch (e) {
    log.warn("folders: registry read failed", { error: String(e) });
  }
}

/**
 * Hydrate the registry for this window. Call once at boot (main.tsx). On the
 * first run after the registry moved to disk (no folders.json yet), seed it —
 * from the CLOUD list when sync is on (until now the only cross-instance
 * truth, so the per-origin localStorage copies may disagree; cloud wins), else
 * from this origin's localStorage. Ends with a folders-updated broadcast so
 * already-mounted pickers re-read.
 */
export async function initFolderRegistry(): Promise<void> {
  if (!isTauri()) return;
  try {
    const raw = await invoke<string>("read_folders");
    if (raw.trim()) {
      const v = parseFolders(raw);
      if (v) {
        cache = v;
        // This origin's localStorage may hold a diverged pre-file copy (the
        // dev instance, say) that components read before hydration landed —
        // refresh the mirror and nudge every mounted picker to re-read.
        if (JSON.stringify(v) !== JSON.stringify(readLocalStorage())) {
          writeLocalStorage(v);
          emitFoldersUpdated().catch(() => {});
        }
        return;
      }
    }
  } catch (e) {
    // Read failed (not just missing) → don't seed over a file we couldn't
    // read; stay on the localStorage fallback for this session.
    log.warn("folders: registry hydrate failed", { error: String(e) });
    return;
  }
  let seed = readLocalStorage();
  try {
    const { CLOUD_ENABLED } = await import("../flags");
    if (CLOUD_ENABLED) {
      // Dynamic import: cloud/folders statically imports this module.
      const { listCloudFolders } = await import("../cloud/folders");
      const cloud = await listCloudFolders();
      if (cloud.length) {
        seed = cloud.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt }));
      }
    }
  } catch (e) {
    log.warn("folders: cloud seed unavailable, using local copy", { error: String(e) });
  }
  persist(seed);
  log.info("folders: registry migrated to disk", { count: seed.length });
  emitFoldersUpdated().catch(() => {});
}

/** Personal folders, oldest first (stable sidebar order). */
export function listLocalFolders(): Folder[] {
  return [...read()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Like {@link listLocalFolders}, but re-reads the disk registry first — for
 *  cross-INSTANCE readers (the MCP list_folders RPC): another running app may
 *  have written folders this window hasn't seen an event for. */
export async function listFoldersFresh(): Promise<Folder[]> {
  await refreshFromDisk();
  return listLocalFolders();
}

/** Replace the whole registry — used to mirror the cloud list down so a
 *  folder created on another device shows here (and one deleted there disappears). */
export function writeLocalFolders(folders: Folder[]): void {
  persist(folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })));
}

/** Create a personal folder and return it. */
export function createLocalFolder(name: string): Folder {
  const f: Folder = { id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() };
  persist([...read(), f]);
  return f;
}

/** Rename a personal folder (no-op if missing). */
export function renameLocalFolder(id: string, name: string): void {
  persist(read().map((f) => (f.id === id ? { ...f, name: name.trim() } : f)));
}

/** Delete a personal folder (the recordings it held fall to the root). */
export function deleteLocalFolder(id: string): void {
  persist(read().filter((f) => f.id !== id));
}

/** Tell other windows the personal folder list changed (History grid, Settings picker). */
export async function emitFoldersUpdated(): Promise<void> {
  if (!isTauri()) return;
  await emit(FOLDERS_UPDATED_EVENT, {});
}

/** Listen for personal-folder changes broadcast from another window. The cache
 *  is refreshed from disk BEFORE the callback runs, so a listener's
 *  `listLocalFolders()` sees the new registry (the old localStorage was shared
 *  across same-origin windows implicitly; the disk cache needs this re-read). */
export async function listenForFoldersUpdated(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen(FOLDERS_UPDATED_EVENT, () => {
    refreshFromDisk()
      .catch(() => {})
      .finally(cb);
  });
}
