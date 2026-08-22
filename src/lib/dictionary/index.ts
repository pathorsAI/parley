//! Phrase dictionary: the terms voice typing (and meeting transcription) should
//! get right — a proper noun the STT keeps mangling, plus the misheard variants
//! seen in the wild.
//!
//! The source of truth is a SHARED CONFIG FILE (`dictionary.json` in the app
//! config dir, via read_dictionary/write_dictionary) — one registry for every
//! window, and the same file the local MCP server reads and writes. Structured
//! after history/folders.ts: disk is truth, an in-memory cache keeps reads
//! synchronous, and a `dictionary://updated` broadcast re-hydrates the other
//! windows. Because the MCP server edits the file behind our back, every window
//! also re-reads on focus (the same trick templatesSync.ts uses).
//!
//! Two things consume the entries:
//!   - `vocabularyTerms()` biases the STT itself (the `vocabulary` argument on
//!     start_voice_typing / start_meeting / transcribe_file), so the right
//!     spelling comes back in the first place;
//!   - `applyReplacements()` rewrites the variants that came back anyway, right
//!     before the text is shown/pasted.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { log } from "../log";

/** Broadcast whenever this window (or the MCP server, via the focus re-read)
 *  changed the dictionary. Payload-free: listeners re-read from disk. */
export const DICTIONARY_UPDATED_EVENT = "dictionary://updated";

/** How many phrases are handed to the STT as recognition bias. Providers cap
 *  the vocabulary list; past a couple hundred terms the hint stops helping and
 *  starts costing latency, so the newest entries win. */
export const VOCABULARY_LIMIT = 200;

/** Where an entry came from: learned from an in-place correction, typed in
 *  Settings, or written by an external tool over MCP. */
export type DictionarySource = "correction" | "manual" | "mcp";

/** One term the user cares about, plus the misheard forms to rewrite into it. */
export interface DictionaryEntry {
  id: string;
  phrase: string;
  variants: string[];
  /** Epoch milliseconds — newest entries bias the STT first. */
  createdAt: number;
  source: DictionarySource;
}

/** A correction the user declined. Two declines and we stop asking (see
 *  {@link isIgnoredTwice}). */
export interface IgnoredCorrection {
  variant: string;
  phrase: string;
  count: number;
}

export interface DictionaryFile {
  entries: DictionaryEntry[];
  ignored: IgnoredCorrection[];
}

/** What {@link addEntry} actually changed, so an undo can reverse exactly that
 *  — a brand new entry is removed wholesale, a variant merged into an existing
 *  entry only takes that variant back out. */
export type AddResult =
  | { kind: "entry"; entryId: string }
  | { kind: "variant"; entryId: string; variant: string };

const EMPTY: DictionaryFile = { entries: [], ignored: [] };

/** Hydrated dictionary (null until initDictionary / the first refresh). */
let cache: DictionaryFile | null = null;
/** True once we've actually read the file. Until then this window knows
 *  NOTHING about the dictionary, and writing what it thinks it holds would
 *  truncate the real file. */
let hydrated = false;
/** Resolves when the first read lands; see {@link whenDictionaryReady}. */
let ready: Promise<void> | null = null;
/** Serializes writes so a slow one can't land after a newer snapshot. */
let writeChain: Promise<void> = Promise.resolve();

/** Parse the file tolerantly: anything missing or malformed degrades to empty
 *  rather than throwing away the parts that ARE readable. Returns null only
 *  when the JSON itself is unusable, which the caller treats as "keep what we
 *  have" instead of "the dictionary is empty now". */
function parseDictionary(raw: string | null): DictionaryFile | null {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<DictionaryFile>;
    if (!v || typeof v !== "object") return null;
    return {
      entries: Array.isArray(v.entries) ? v.entries.filter(isEntry).map(normalizeEntry) : [],
      ignored: Array.isArray(v.ignored) ? v.ignored.filter(isIgnored) : [],
    };
  } catch {
    return null;
  }
}

function isEntry(e: unknown): e is DictionaryEntry {
  const v = e as DictionaryEntry | null;
  return !!v && typeof v.id === "string" && typeof v.phrase === "string";
}

function isIgnored(e: unknown): e is IgnoredCorrection {
  const v = e as IgnoredCorrection | null;
  return !!v && typeof v.variant === "string" && typeof v.phrase === "string";
}

/** Fill in whatever an external writer (MCP, a hand-edited file) left out. */
function normalizeEntry(e: DictionaryEntry): DictionaryEntry {
  return {
    id: e.id,
    phrase: e.phrase,
    variants: Array.isArray(e.variants) ? e.variants.filter((v) => typeof v === "string") : [],
    createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    source: e.source === "manual" || e.source === "mcp" ? e.source : "correction",
  };
}

function read(): DictionaryFile {
  return cache ?? EMPTY;
}

/** Commit a new dictionary: cache first (so the synchronous readers see it
 *  immediately), then disk, then the cross-window broadcast — announced only
 *  after the write lands, or a listener would re-read the previous file. */
function persist(next: DictionaryFile): void {
  if (isTauri() && !hydrated) {
    // Nothing has been read yet, so `next` was computed against an empty
    // dictionary — writing it would wipe the file. Every UI path waits on
    // whenDictionaryReady(), so this is a bug backstop, not a normal branch.
    log.error("dictionary: write skipped, the file has not been read yet");
    return;
  }
  cache = next;
  if (!isTauri()) return;
  writeChain = writeChain
    .then(() => invoke("write_dictionary", { contents: JSON.stringify(next, null, 2) }))
    .then(() => emit(DICTIONARY_UPDATED_EVENT, {}))
    .then(() => {})
    .catch((error) => log.error("dictionary: write failed", { error: String(error) }));
}

/** Re-read the on-disk dictionary into the cache. Returns true when the
 *  contents actually changed (used to decide whether to tell other windows). */
async function refreshFromDisk(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const raw = await invoke<string>("read_dictionary");
    // A missing file comes back as "" — that's an empty dictionary, and it
    // counts as a successful read (first run has to be writable).
    hydrated = true;
    const next = raw.trim() ? parseDictionary(raw) : EMPTY;
    if (!next) return false;
    const changed = JSON.stringify(next) !== JSON.stringify(cache);
    cache = next;
    return changed;
  } catch (e) {
    log.warn("dictionary: read failed", { error: String(e) });
    return false;
  }
}

/**
 * Hydrate the dictionary for this window and keep it honest afterwards. Call
 * once at boot from main.tsx — EVERY window needs it: the main window rewrites
 * dictated text before pasting, the overlay rewrites what it displays, Settings
 * edits the list.
 *
 * The focus re-read is what makes an MCP-side edit show up: that server writes
 * the same file while the app sits in the background, and a stale in-memory
 * cache would silently overwrite it on the next local edit.
 */
export async function initDictionary(): Promise<void> {
  if (!isTauri()) {
    hydrated = true; // browser dev: an in-memory dictionary is all there is
    return;
  }
  ready = refreshFromDisk().then(() => {});
  await ready;
  window.addEventListener("focus", () => {
    refreshFromDisk()
      .then((changed) => (changed ? emit(DICTIONARY_UPDATED_EVENT, {}) : undefined))
      .catch((error) => log.warn("dictionary: focus refresh failed", { error: String(error) }));
  });
}

/**
 * Resolves once this window has read the dictionary file. Anything that WRITES
 * — a Settings edit, accepting a correction — must await this first, or it
 * would be deciding against an empty dictionary. Reads can skip it and simply
 * see nothing for the moment hydration takes.
 */
export function whenDictionaryReady(): Promise<void> {
  return ready ?? Promise.resolve();
}

/** Listen for dictionary changes from this or another window. The cache is
 *  refreshed from disk BEFORE the callback runs, so a listener's
 *  `listEntries()` already sees the new file. */
export async function listenForDictionaryUpdated(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen(DICTIONARY_UPDATED_EVENT, () => {
    refreshFromDisk()
      .catch(() => false)
      .finally(cb);
  });
}

/** Every entry, newest first (the order Settings lists them in). */
export function listEntries(): DictionaryEntry[] {
  return [...read().entries].sort((a, b) => b.createdAt - a.createdAt);
}

/** Declined corrections, as stored. */
export function listIgnored(): IgnoredCorrection[] {
  return [...read().ignored];
}

/** Trim, drop blanks and duplicates, and never let a variant equal its phrase. */
function cleanVariants(variants: readonly string[], phrase: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of variants) {
    const v = raw.trim();
    if (!v || v === phrase || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Add a phrase — or, when that exact phrase is already known (case-SENSITIVE:
 * "parley" and "Parley" are different terms to a dictation user), merge the new
 * variants into the existing entry instead of growing a second row for it.
 *
 * Returns what actually changed so an undo can be precise, or null when there
 * was nothing to add (blank phrase, or every variant already known).
 */
export function addEntry(input: {
  phrase: string;
  variants?: readonly string[];
  source: DictionarySource;
}): AddResult | null {
  const phrase = input.phrase.trim();
  if (!phrase) return null;
  const variants = cleanVariants(input.variants ?? [], phrase);
  const file = read();
  const existing = file.entries.find((e) => e.phrase === phrase);
  if (existing) {
    const fresh = variants.filter((v) => !existing.variants.includes(v));
    if (fresh.length === 0) return null;
    persist({
      ...file,
      entries: file.entries.map((e) =>
        e.id === existing.id ? { ...e, variants: [...e.variants, ...fresh] } : e,
      ),
    });
    // Undo reverses the variant this call introduced. The correction loop — the
    // only caller with an undo — always adds exactly one.
    return { kind: "variant", entryId: existing.id, variant: fresh[0] };
  }
  const entry: DictionaryEntry = {
    id: crypto.randomUUID(),
    phrase,
    variants,
    createdAt: Date.now(),
    source: input.source,
  };
  persist({ ...file, entries: [...file.entries, entry] });
  return { kind: "entry", entryId: entry.id };
}

/** Edit an entry in place (no-op if the id is unknown). */
export function updateEntry(
  id: string,
  patch: Partial<Pick<DictionaryEntry, "phrase" | "variants" | "source">>,
): void {
  const file = read();
  if (!file.entries.some((e) => e.id === id)) return;
  persist({
    ...file,
    entries: file.entries.map((e) => {
      if (e.id !== id) return e;
      const phrase = patch.phrase !== undefined ? patch.phrase.trim() : e.phrase;
      const variants =
        patch.variants !== undefined ? cleanVariants(patch.variants, phrase) : e.variants;
      return { ...e, phrase, variants, source: patch.source ?? e.source };
    }),
  });
}

/** Drop an entry and everything it taught us. */
export function removeEntry(id: string): void {
  const file = read();
  if (!file.entries.some((e) => e.id === id)) return;
  persist({ ...file, entries: file.entries.filter((e) => e.id !== id) });
}

/** Drop one variant from an entry, leaving the phrase itself in place. */
export function removeVariant(entryId: string, variant: string): void {
  const file = read();
  persist({
    ...file,
    entries: file.entries.map((e) =>
      e.id === entryId ? { ...e, variants: e.variants.filter((v) => v !== variant) } : e,
    ),
  });
}

/** Remember that the user declined this correction (once more). */
export function recordIgnore(variant: string, phrase: string): void {
  const file = read();
  const hit = file.ignored.find((i) => i.variant === variant && i.phrase === phrase);
  const ignored = hit
    ? file.ignored.map((i) => (i === hit ? { ...i, count: i.count + 1 } : i))
    : [...file.ignored, { variant, phrase, count: 1 }];
  persist({ ...file, ignored });
}

/** Declined twice → stop offering this correction. Once is an accident; twice
 *  is an answer. */
export function isIgnoredTwice(variant: string, phrase: string): boolean {
  const hit = read().ignored.find((i) => i.variant === variant && i.phrase === phrase);
  return !!hit && hit.count >= 2;
}

/** The phrases handed to the STT as recognition bias: deduped, newest first,
 *  capped at {@link VOCABULARY_LIMIT}. */
export function vocabularyTerms(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of listEntries()) {
    const phrase = e.phrase.trim();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
    if (out.length >= VOCABULARY_LIMIT) break;
  }
  return out;
}

const ASCII_ONLY = /^[\x00-\x7F]+$/;
const WORD_EDGE_START = /^[A-Za-z0-9_]/;
const WORD_EDGE_END = /[A-Za-z0-9_]$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite every known variant into its phrase.
 *
 * ASCII variants match case-insensitively and only as whole words — "parley"
 * must not eat the "parle" inside "parlement", and the STT's casing is
 * arbitrary anyway. A variant with any non-ASCII character (the zh case) has no
 * word boundaries to speak of, so it's a plain global substring replace.
 *
 * Longer variants go first: with both "Parley" and "Parley Cloud" on file, the
 * longer phrase must win instead of being half-rewritten by the shorter one.
 *
 * `entries` defaults to the live dictionary; pass an explicit list to rewrite
 * against a specific set (and to test this without touching disk).
 */
export function applyReplacements(
  text: string,
  entries: readonly DictionaryEntry[] = listEntries(),
): string {
  if (!text) return text;
  const pairs: { variant: string; phrase: string }[] = [];
  for (const e of entries) {
    const phrase = e.phrase.trim();
    if (!phrase) continue;
    for (const variant of e.variants) {
      if (variant.trim()) pairs.push({ variant, phrase });
    }
  }
  pairs.sort((a, b) => b.variant.length - a.variant.length);
  let out = text;
  for (const { variant, phrase } of pairs) {
    if (ASCII_ONLY.test(variant)) {
      const before = WORD_EDGE_START.test(variant) ? "(?<![A-Za-z0-9_])" : "";
      const after = WORD_EDGE_END.test(variant) ? "(?![A-Za-z0-9_])" : "";
      // A function replacer, so a `$` in the phrase stays literal.
      out = out.replace(new RegExp(`${before}${escapeRegExp(variant)}${after}`, "gi"), () => phrase);
    } else {
      out = out.split(variant).join(phrase);
    }
  }
  return out;
}
