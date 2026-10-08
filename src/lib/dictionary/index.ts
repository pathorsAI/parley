//! Phrase dictionary: the terms voice typing (and meeting transcription) should
//! get right — a proper noun the STT keeps mangling, plus the misheard variants
//! seen in the wild.
//!
//! The source of truth is a SHARED CONFIG FILE (`dictionary.json` in the app
//! config dir, via read_dictionary/write_dictionary) — one registry for every
//! window, and the same file the local MCP server reads and writes. Structured
//! after history/folders.ts: disk is truth, an in-memory cache keeps reads
//! synchronous, and a `dictionary://updated` broadcast (from any window, and
//! from the MCP server after its own writes) re-hydrates every OTHER window.
//! Each window also re-reads on focus, as a backstop for a writer that never
//! announces itself (a hand-edited file).
//!
//! Two things consume the entries:
//!   - `recognitionTerms()` (the profile name and company, then
//!     `vocabularyTerms()`) biases the STT itself (the `vocabulary` argument on
//!     start_voice_typing / start_meeting / transcribe_file), so the right
//!     spelling comes back in the first place;
//!   - `applyReplacements()` rewrites the variants that came back anyway, right
//!     before the text is shown/pasted.
//!
//! When the user is signed in with cloud sync on, ../cloud/dictionarySync
//! mirrors the entries to their Parley account (and so to the iPhone). That is
//! why every content change stamps `updatedAt`: sync is last-write-wins on it.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import type { Settings } from "../types";

/** Broadcast whenever the dictionary file changed: by a window's own write, by
 *  a window that found a change on focus, or by the MCP server (Rust, see
 *  mcp.rs). The payload only says who sent it ({@link UpdatedPayload});
 *  listeners re-read from disk. */
export const DICTIONARY_UPDATED_EVENT = "dictionary://updated";

/** Who announced a change: a window's {@link ORIGIN}, or "mcp" from Rust. Older
 *  senders put `{}` on the wire, which simply reads as "someone else". */
type UpdatedPayload = { origin?: string };

/** This window's sender id. A window must not re-read on its OWN broadcast: the
 *  cache already holds that state (it was set before the write was queued), and
 *  the read could only race the write chain. */
const ORIGIN = crypto.randomUUID();

function isOwn(p: UpdatedPayload | null | undefined): boolean {
  return p?.origin === ORIGIN;
}

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
  /** Epoch milliseconds of the last change to the phrase, its variants or its
   *  source — the clock cloud sync resolves conflicts with. Absent on entries
   *  written before sync existed (sync falls back to `createdAt`). */
  updatedAt?: number;
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
/** Bumped by every {@link persist}. A read that was in flight while this moved
 *  saw the file from BEFORE that change, and must not replace the cache. */
let localEdits = 0;

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
    ...(typeof e.updatedAt === "number" ? { updatedAt: e.updatedAt } : {}),
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
  localEdits += 1;
  if (!isTauri()) return;
  writeChain = writeChain
    .then(() => invoke("write_dictionary", { contents: JSON.stringify(next, null, 2) }))
    .then(() => emit(DICTIONARY_UPDATED_EVENT, { origin: ORIGIN } satisfies UpdatedPayload))
    .then(() => {})
    .catch((error) => log.error("dictionary: write failed", { error: String(error) }));
}

/** Re-read the on-disk dictionary into the cache. Returns true when the
 *  contents actually changed (used to decide whether to tell other windows). */
async function refreshFromDisk(): Promise<boolean> {
  if (!isTauri()) return false;
  const editsBefore = localEdits;
  try {
    const raw = await invoke<string>("read_dictionary");
    // This window changed the dictionary while the read was in flight, so the
    // file we got predates the cache. Its write is queued and will land as the
    // newer state; applying this read would roll the cache back to a file
    // without that change, and the next edit would write the rollback to disk.
    if (localEdits !== editsBefore) return false;
    // write_config_file (commands.rs) and the MCP server both write with a
    // plain, non-atomic `std::fs::write`: truncate, then write. A read that
    // lands in between sees an empty file — and the Rust side maps a read
    // error to "" as well. Once this window holds a real dictionary, an empty
    // read is far more likely to be that than a user who emptied the file by
    // hand; taking it would paste without replacements, and the next local
    // edit would write the near-empty result over the real file.
    if (!raw.trim() && hydrated && cache && (cache.entries.length || cache.ignored.length)) {
      log.warn("dictionary: empty read ignored (a write was mid-flight)");
      return false;
    }
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
 * Re-read once this window's own queued writes have landed. A foreign event can
 * arrive between a local `persist` (cache already updated, write still queued)
 * and that write reaching disk; reading right then would hand back a file
 * without our change and roll the cache back to it — and since the write's own
 * broadcast is then ignored as ours, the rollback would stick.
 */
function refreshAfterWrites(): Promise<boolean> {
  return writeChain.then(refreshFromDisk);
}

/** Re-read the file now and, when it changed behind our back (a hand edit, or
 *  an MCP write whose broadcast was missed), tell the other windows too. */
export async function refreshDictionary(): Promise<void> {
  if (await refreshAfterWrites()) {
    await emit(DICTIONARY_UPDATED_EVENT, { origin: ORIGIN } satisfies UpdatedPayload);
  }
}

/**
 * Hydrate the dictionary for this window and keep it current afterwards. Call
 * once at boot from main.tsx — EVERY window needs it: the main window rewrites
 * dictated text before pasting, the overlay rewrites what it displays, Settings
 * edits the list.
 *
 * Every window follows every other writer through `dictionary://updated`. It
 * used to re-read on window `focus` alone, which looked sufficient and was not:
 * the window that rewrites dictated text is the voice-typing overlay, and the
 * overlay is non-activating on purpose (a borderless NSPanel on macOS, which can
 * never become key; WS_EX_NOACTIVATE on Windows) so it never steals the caret
 * from the app being dictated into. It therefore never received `focus`, and
 * kept rewriting with the file it read at launch — an entry added in Settings,
 * accepted from a correction bubble, or written over MCP did nothing until the
 * app restarted. Nothing outside the Settings dictionary page listened for the
 * broadcast. The main window had the same gap for its STT bias whenever it was
 * not refocused (tray-only on Windows, or dictating straight into another app).
 *
 * The listener goes up BEFORE the first read, so a change that lands while that
 * read is in flight still gets a re-read of its own.
 */
export async function initDictionary(): Promise<void> {
  if (!isTauri()) {
    hydrated = true; // browser dev: an in-memory dictionary is all there is
    return;
  }
  listen<UpdatedPayload>(DICTIONARY_UPDATED_EVENT, (e) => {
    if (!isOwn(e.payload)) void refreshAfterWrites();
  }).catch((error) => log.warn("dictionary: update listener failed", { error: String(error) }));
  ready = refreshFromDisk().then(() => {});
  await ready;
  window.addEventListener("focus", () => {
    refreshDictionary().catch((error) =>
      log.warn("dictionary: focus refresh failed", { error: String(error) }),
    );
  });
}

/** Re-read the file now (rather than on the next focus or broadcast). Cloud
 *  sync calls this before it diffs, so an edit another window or the MCP server
 *  just made is never mistaken for a missing entry. */
export async function reloadDictionary(): Promise<void> {
  await refreshFromDisk();
}

/**
 * Replace the whole entry list in one write — cloud sync's way of applying what
 * the server sent back. Everything else in the file (declined corrections) is
 * kept. Broadcasts like any other edit.
 */
export function replaceEntries(entries: DictionaryEntry[]): void {
  persist({ ...read(), entries });
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

/** Listen for dictionary changes from this or another window (or MCP). The
 *  cache is refreshed from disk BEFORE the callback runs, so a listener's
 *  `listEntries()` already sees the new file. On this window's own broadcast
 *  the cache is already current, so the callback runs without a re-read. */
export async function listenForDictionaryUpdated(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<UpdatedPayload>(DICTIONARY_UPDATED_EVENT, (e) => {
    (isOwn(e.payload) ? Promise.resolve(false) : refreshAfterWrites())
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
        e.id === existing.id
          ? { ...e, variants: [...e.variants, ...fresh], updatedAt: Date.now() }
          : e,
      ),
    });
    // Undo reverses the variant this call introduced. The correction loop — the
    // only caller with an undo — always adds exactly one.
    return { kind: "variant", entryId: existing.id, variant: fresh[0] };
  }
  const now = Date.now();
  const entry: DictionaryEntry = {
    id: crypto.randomUUID(),
    phrase,
    variants,
    createdAt: now,
    updatedAt: now,
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
      const phrase = patch.phrase === undefined ? e.phrase : patch.phrase.trim();
      const variants =
        patch.variants === undefined ? e.variants : cleanVariants(patch.variants, phrase);
      return { ...e, phrase, variants, source: patch.source ?? e.source, updatedAt: Date.now() };
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
      e.id === entryId
        ? { ...e, variants: e.variants.filter((v) => v !== variant), updatedAt: Date.now() }
        : e,
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

/** One profile field may hold several spellings — the Settings placeholder
 *  itself reads "王小明 / Ming". Slash (half or full width), comma, 、, ; and |
 *  separate them; whitespace does NOT ("Jane Doe" is one name, and the STT
 *  takes multi-word terms). */
const PROFILE_TERM_SPLIT = /\s*[/／,，、;；|]\s*/;
/** Longer than this is prose, not a name. */
const PROFILE_TERM_MAX_CHARS = 40;

/**
 * The user's own proper nouns from Settings › Basic — their name and their
 * company — split into the separate spellings a field may hold, trimmed and
 * deduped, name first.
 *
 * These are the words a dictation is most likely to contain and the STT is
 * least likely to know, yet voice typing used to ignore them entirely: only
 * the meeting prompts read the profile. Role and background are left out on
 * purpose — a job title is ordinary vocabulary the STT already spells right,
 * and free-text background is not a term at all.
 */
export function profileTerms(s: Pick<Settings, "userName" | "userCompany">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of [s.userName, s.userCompany]) {
    for (const part of (field || "").split(PROFILE_TERM_SPLIT)) {
      const term = part.trim();
      if (!term || [...term].length > PROFILE_TERM_MAX_CHARS || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}

/**
 * The recognition bias for one STT session: the profile terms FIRST, then the
 * dictionary (newest first), deduped and capped at {@link VOCABULARY_LIMIT}.
 * Profile terms lead because they must never age out of the cap — a large
 * dictionary costs its oldest phrase a slot instead.
 *
 * Also the anchors the correction loop widens a CJK edit to (see
 * `detectCorrection`), since these are exactly the whole terms a one-character
 * fix belongs to.
 */
export function recognitionTerms(
  s: Pick<Settings, "userName" | "userCompany">,
  dictionary: readonly string[] = vocabularyTerms(),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...profileTerms(s), ...dictionary]) {
    const term = raw.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= VOCABULARY_LIMIT) break;
  }
  return out;
}

const ASCII_ONLY = /^[\x00-\x7F]+$/;
const WORD_EDGE_START = /^\w/;
const WORD_EDGE_END = /\w$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Every (variant → phrase) rewrite on file, longest variant first: with both
 *  "Parley" and "Parley Cloud" known, the longer one has to win. */
function replacementPairs(
  entries: readonly DictionaryEntry[],
): { variant: string; phrase: string }[] {
  const pairs: { variant: string; phrase: string }[] = [];
  for (const e of entries) {
    const phrase = e.phrase.trim();
    if (!phrase) continue;
    for (const variant of e.variants) {
      if (variant.trim()) pairs.push({ variant, phrase });
    }
  }
  pairs.sort((a, b) => b.variant.length - a.variant.length);
  return pairs;
}

/** Case-insensitive matcher for an ASCII variant, asserting a word boundary on
 *  whichever sides actually start/end with a word character. */
function asciiVariantRe(variant: string): RegExp {
  const before = WORD_EDGE_START.test(variant) ? "(?<![A-Za-z0-9_])" : "";
  const after = WORD_EDGE_END.test(variant) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${before}${escapeRegExp(variant)}${after}`, "gi");
}

/** Whether `phrase` properly contains `variant` — the pair would grow text that
 *  is already right (派斯 → 派斯科技 turns 派斯科技 into 派斯科技科技). Compared
 *  the way the variant matches: case-insensitively for an ASCII variant. A
 *  case-only pair (parley → Parley) is the same length, so it is not growth. */
function phraseContainsVariant(phrase: string, variant: string, ascii: boolean): boolean {
  if (phrase.length <= variant.length) return false;
  return ascii ? phrase.toLowerCase().includes(variant.toLowerCase()) : phrase.includes(variant);
}

/** Where `phrase` already stands in `text`, as [start, end) UTF-16 ranges. */
function phraseRanges(text: string, phrase: string, ascii: boolean): [number, number][] {
  const re = new RegExp(escapeRegExp(phrase), ascii ? "gi" : "g");
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
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
 * A phrase that properly contains its own variant (派斯 → 派斯科技, parley →
 * Parley Cloud) only rewrites the variant where it is NOT already part of the
 * phrase, so text the STT got right stays right and a second pass over the
 * same text changes nothing. iOS refuses such pairs outright (`Lexicon.loops`
 * in LexiconStore.swift); masking keeps the pair the user configured working
 * instead of silently dropping it, and the pass idempotent — the host runs it
 * again over the polished text.
 *
 * `entries` defaults to the live dictionary; pass an explicit list to rewrite
 * against a specific set (and to test this without touching disk).
 */
export function applyReplacements(
  text: string,
  entries: readonly DictionaryEntry[] = listEntries(),
): string {
  if (!text) return text;
  let out = text;
  for (const { variant, phrase } of replacementPairs(entries)) {
    const ascii = ASCII_ONLY.test(variant);
    const re = ascii ? asciiVariantRe(variant) : new RegExp(escapeRegExp(variant), "g");
    // Matched against the whole string rather than the gaps between the
    // phrase's occurrences, so an ASCII variant's word-boundary lookarounds
    // still see the real neighbouring characters.
    const guard = phraseContainsVariant(phrase, variant, ascii)
      ? phraseRanges(out, phrase, ascii)
      : [];
    // A function replacer, so a `$` in the phrase stays literal.
    out = out.replace(re, (match: string, offset: number) =>
      guard.some(([s, e]) => offset < e && offset + match.length > s) ? match : phrase,
    );
  }
  return out;
}
