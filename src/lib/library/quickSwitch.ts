/**
 * Ranking for the ⌘K quick switcher (issue #332).
 *
 * The tree in the sidebar is aim-and-click: you have to know where a thing
 * lives before you can reach it. This module is the other half — name it and
 * go. It answers exactly one question ("which of these places best matches
 * what the user typed?") and knows nothing about React, the store, or i18n, so
 * the ordering can be pinned down by tests instead of by clicking around.
 *
 * The matcher is deliberately a small greedy subsequence scan rather than a
 * fuzzy-search engine: a folder list is tens of rows, not tens of thousands,
 * and a scorer you can read in one sitting is worth more here than one that
 * squeezes out the last few percent of ranking quality.
 */

/** Somewhere the palette can jump to. */
export type QuickTarget =
  | { kind: "home" }
  | { kind: "all"; count: number }
  | { kind: "folder"; id: string; name: string; count: number }
  | { kind: "unassigned"; count: number }
  | { kind: "voice" }
  | { kind: "org"; orgId: string; orgName: string }
  | { kind: "orgFolder"; orgId: string; orgName: string; id: string; name: string }
  | { kind: "recording"; id: string; title: string; createdAt: number; folderId: string | null };

/**
 * The fixed nodes are named by the dictionary, not by the data, so the
 * caller hands their translated labels in rather than this module importing
 * `i18n` (which would drag the store into a pure, node-tested module).
 */
export interface QuickSwitchLabels {
  home: string;
  all: string;
  unassigned: string;
  voice: string;
}

/** Stable identity for a target — for React keys and selection comparison. */
export function targetKey(t: QuickTarget): string {
  switch (t.kind) {
    case "home":
      return "home";
    case "all":
      return "all";
    case "folder":
      return `folder:${t.id}`;
    case "unassigned":
      return "unassigned";
    case "voice":
      return "voice";
    case "org":
      return `org:${t.orgId}`;
    case "orgFolder":
      return `orgFolder:${t.orgId}:${t.id}`;
    case "recording":
      return `recording:${t.id}`;
  }
}

/** The text a target is matched against. */
export function targetLabel(t: QuickTarget, labels: QuickSwitchLabels): string {
  switch (t.kind) {
    case "home":
      return labels.home;
    case "all":
      return labels.all;
    case "unassigned":
      return labels.unassigned;
    case "voice":
      return labels.voice;
    case "folder":
    case "orgFolder":
      return t.name;
    case "org":
      return t.orgName;
    case "recording":
      return t.title;
  }
}

/** What an empty query scores: a constant, so "no query" means "everything". */
export const EMPTY_QUERY_SCORE = 0;

/** Characters that make the next character read as the start of a word. */
const WORD_BREAKS = new Set([" ", "-", "_", "/", "·"]);

const MATCHED_CHAR = 10;
const WORD_START = 15;
const CONTIGUOUS = 12;
/** A skipped run costs a little, but never enough to swamp a real match. */
const MAX_GAP_PENALTY = 8;
/** How far a late first match can be punished for starting late. */
const MAX_OFFSET_PENALTY = 20;
const PREFIX = 300;
const EXACT = 1000;

function isWordStart(text: string, at: number): boolean {
  return at === 0 || WORD_BREAKS.has(text[at - 1]);
}

/**
 * How well `query` matches `text` — `null` when it doesn't at all, otherwise a
 * score where higher is better. Case-insensitive, and matched as a SUBSEQUENCE
 * of the query's characters, so `和車` finds `和運租車` and `lib scr` finds
 * `LibraryScreen` (whitespace is stripped from the query, never from the text).
 */
export function scoreMatch(query: string, text: string): number | null {
  const trimmed = query.trim().toLowerCase();
  const needle = trimmed.replace(/\s+/g, "");
  if (needle.length === 0) return EMPTY_QUERY_SCORE;

  const hay = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -1;
  let firstAt = -1;

  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    if (firstAt < 0) firstAt = at;
    score += MATCHED_CHAR;
    if (isWordStart(hay, at)) score += WORD_START;
    if (at === prev + 1) score += CONTIGUOUS;
    else if (prev >= 0) score -= Math.min(at - prev - 1, MAX_GAP_PENALTY);
    prev = at;
    from = at + 1;
  }

  // A match that starts earlier is the one the user more likely meant.
  score -= Math.min(firstAt, MAX_OFFSET_PENALTY);

  if (hay === trimmed || hay === needle) return score + EXACT;
  if (hay.startsWith(trimmed) || hay.startsWith(needle)) return score + PREFIX;
  return score;
}

/** Navigation nodes sort ahead of recordings when scores tie. */
function isNavigation(t: QuickTarget): boolean {
  return t.kind !== "recording";
}

function isFolderish(t: QuickTarget): boolean {
  return t.kind === "folder" || t.kind === "orgFolder";
}

interface Scored {
  target: QuickTarget;
  score: number;
  /** Input position — the "natural order" an empty query has to preserve. */
  index: number;
}

/**
 * The palette's result list: everything that matches `query`, best first,
 * capped at `limit`.
 *
 * With an EMPTY query this is the default listing rather than nothing — the
 * navigation nodes in the order the caller supplied them, then the newest
 * recordings — because a switcher that opens blank makes you type before it
 * will admit what it can do.
 */
export function searchTargets(
  targets: readonly QuickTarget[],
  query: string,
  labels: QuickSwitchLabels,
  limit = 30
): QuickTarget[] {
  const blank = query.trim().length === 0;
  const scored: Scored[] = [];
  targets.forEach((target, index) => {
    const score = scoreMatch(query, targetLabel(target, labels));
    if (score === null) return;
    scored.push({ target, score, index });
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const navA = isNavigation(a.target);
    const navB = isNavigation(b.target);
    if (navA !== navB) return navA ? -1 : 1;
    if (a.target.kind === "recording" && b.target.kind === "recording") {
      if (a.target.createdAt !== b.target.createdAt) {
        return b.target.createdAt - a.target.createdAt;
      }
    }
    // Folder names only break ties once the user has typed: with a blank query
    // the caller's own order IS the answer (home, folders, unassigned, …).
    if (!blank && isFolderish(a.target) && isFolderish(b.target)) {
      const byName = targetLabel(a.target, labels).localeCompare(targetLabel(b.target, labels));
      if (byName !== 0) return byName;
    }
    return a.index - b.index;
  });

  return scored.slice(0, Math.max(0, limit)).map((s) => s.target);
}
