// Where the people notes live: `people.json` in the app's config dir, on this
// computer only — not synced, and never part of a recording, so sharing a
// recording to an organisation does not carry anyone's notes with it. Outside
// Tauri (plain browser dev) it falls back to localStorage.
//
// One reader/writer: the main window. Writes are serialised so two changes
// landing together (an extraction finishing while the user keeps a candidate)
// cannot overwrite each other. Logs carry ids and counts, never a name or a
// note.

import { useSyncExternalStore } from "react";
import { isTauri } from "../platform";
import { log } from "../log";
import * as ipc from "../ipc/commands";
import { emptyPeople, normalizePeople, type PeopleDoc } from "./notes";

const BROWSER_KEY = "parley:people";

let cache: PeopleDoc | null = null;
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

async function readRaw(): Promise<string> {
  if (isTauri()) return ipc.readPeople();
  return globalThis.localStorage?.getItem(BROWSER_KEY) ?? "";
}

async function writeRaw(contents: string): Promise<void> {
  if (isTauri()) await ipc.writePeople({ contents });
  else globalThis.localStorage?.setItem(BROWSER_KEY, contents);
}

/** The people document, read once and then served from memory. An unreadable
 *  file throws rather than reading as empty: a write would erase it. */
export async function loadPeople(): Promise<PeopleDoc> {
  if (cache) return cache;
  const raw = await readRaw();
  cache = raw.trim() ? normalizePeople(JSON.parse(raw)) : emptyPeople();
  for (const l of listeners) l();
  return cache;
}

/** Apply `change` to the document and save it. Returns the new document; a
 *  change that returns the same document writes nothing. */
export function mutatePeople(change: (doc: PeopleDoc) => PeopleDoc): Promise<PeopleDoc> {
  const run = chain.then(async () => {
    const before = await loadPeople();
    const after = change(before);
    if (after === before) return before;
    await writeRaw(JSON.stringify(after));
    cache = after;
    for (const l of listeners) l();
    return after;
  });
  chain = run.catch((error) => log.warn("people: write failed", { error: String(error) }));
  return run;
}

/** The document as last loaded, for a component; null until the first load. */
export function usePeople(): PeopleDoc | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      if (!cache) void loadPeople().catch((error) => log.warn("people: load failed", { error: String(error) }));
      return () => listeners.delete(onChange);
    },
    () => cache,
  );
}

/** Tests only: forget what was loaded. */
export function resetPeopleForTests(): void {
  cache = null;
  chain = Promise.resolve();
}
