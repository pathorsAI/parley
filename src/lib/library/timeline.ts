/**
 * Date bucketing for the 所有錄音 timeline (issue #330).
 *
 * The library grid answers "what is in this folder". The all-recordings node
 * answers a different question — "what did I sit through lately" — and that one
 * is read down a calendar, not across a grid. Grouping by day is what makes the
 * answer scannable: 今天 / 昨天 / 本週稍早, then by month once a recording is old
 * enough that the exact day has stopped mattering.
 *
 * Pure and clock-injected: `now` is a parameter, never `Date.now()`, so the
 * boundaries can be pinned down by tests instead of by waiting until midnight.
 * Labels are NOT produced here — this module has no i18n and no locale; the
 * caller turns a bucket into text.
 */

/** Which band of the calendar a recording falls into, relative to `now`. */
export type TimelineBucket =
  | { kind: "today" }
  | { kind: "yesterday" }
  /** Earlier in the same week (weeks start Monday). */
  | { kind: "thisWeek" }
  /** Anything older, gathered per calendar month. `month` is 0-indexed. */
  | { kind: "month"; year: number; month: number };

/** The minimum a recording has to expose to be placed on the timeline. */
export interface DatedRecording {
  createdAt: number;
}

export interface TimelineGroup<T extends DatedRecording> {
  /** Stable identity for React keys and tests — see {@link bucketKey}. */
  key: string;
  bucket: TimelineBucket;
  /** Newest first, like the groups themselves. */
  items: T[];
}

/** Local midnight on the day `ts` falls in. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight `days` days before the day `ts` falls in. Done with calendar
 *  arithmetic rather than subtracting 24h in ms so a DST shift can't move it. */
function startOfDayBefore(ts: number, days: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/** Local midnight on the Monday of the week `ts` falls in. Monday because these
 *  are work meetings: a Sunday that starts the week orphans the Friday before. */
function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * The bucket `createdAt` belongs to.
 *
 * Yesterday deliberately outranks the week boundary: on a Monday, "昨天" is a
 * better answer than "上個月" for something recorded on the Sunday. A timestamp
 * in the future (clock skew on a synced recording) lands in today rather than
 * falling out of the timeline.
 */
export function bucketFor(createdAt: number, now: number): TimelineBucket {
  if (createdAt >= startOfDay(now)) return { kind: "today" };
  if (createdAt >= startOfDayBefore(now, 1)) return { kind: "yesterday" };
  if (createdAt >= startOfWeek(now)) return { kind: "thisWeek" };
  const d = new Date(createdAt);
  return { kind: "month", year: d.getFullYear(), month: d.getMonth() };
}

/** Stable identity for a bucket. */
export function bucketKey(bucket: TimelineBucket): string {
  return bucket.kind === "month" ? `month:${bucket.year}-${bucket.month}` : bucket.kind;
}

/**
 * Group recordings into the timeline, newest first — both the groups and the
 * items inside them.
 *
 * The caller's array is not assumed to be sorted: the summaries happen to
 * arrive newest-first today, and a timeline that quietly depends on that would
 * shuffle itself the first time someone changes the list query.
 */
export function groupByDate<T extends DatedRecording>(
  entries: readonly T[],
  now: number
): TimelineGroup<T>[] {
  const groups: TimelineGroup<T>[] = [];
  const byKey = new Map<string, TimelineGroup<T>>();
  for (const entry of [...entries].sort((a, b) => b.createdAt - a.createdAt)) {
    const bucket = bucketFor(entry.createdAt, now);
    const key = bucketKey(bucket);
    let group = byKey.get(key);
    if (!group) {
      group = { key, bucket, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(entry);
  }
  return groups;
}
