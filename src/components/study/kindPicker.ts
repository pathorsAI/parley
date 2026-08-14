/**
 * Pure helpers for the meeting-kind picker. Kept out of the component so the
 * ordering rule — the one thing that decides whether the picker stays usable
 * once kinds can be created on the fly — is testable without a DOM.
 */

/** Upper bound on `settings.recentMeetingTypes`. Long enough to hold the set
 *  someone actually rotates through, short enough that the recent block never
 *  becomes the whole list again. */
export const RECENT_MEETING_TYPES_MAX = 8;

/**
 * Record a pick: newest first, no duplicates, capped. Returns a new array —
 * the caller hands it straight to `updateSettings`.
 */
export function pushRecentMeetingType(
  recent: readonly string[],
  id: string,
  max: number = RECENT_MEETING_TYPES_MAX
): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max);
}

/**
 * Recently-picked entries first (in `recent` order), then everything else in
 * the set's own order. Ids in `recent` that no longer resolve are skipped: a
 * deleted kind must not leave a hole at the top of the picker.
 */
export function sortByRecent<T extends { id: string }>(
  list: readonly T[],
  recent: readonly string[]
): T[] {
  const byId = new Map(list.map((x) => [x.id, x]));
  const front: T[] = [];
  const seen = new Set<string>();
  for (const id of recent) {
    const hit = byId.get(id);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    front.push(hit);
  }
  return [...front, ...list.filter((x) => !seen.has(x.id))];
}

/**
 * Derive a scenario id from a display name: lowercase, anything outside
 * `a-z0-9` becomes a hyphen, runs collapse, edges trimmed. A purely
 * non-Latin name (the common case in zh-TW) slugs to "" — the form then asks
 * for an id instead of inventing one, because the id is what MCP and saved
 * recordings refer to the kind by.
 */
export function slugifyKindId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
