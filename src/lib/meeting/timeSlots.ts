/** Minutes between the times the pickers offer (Google Calendar's step). */
export const SLOT_MIN = 15;
/** A new meeting's length until the user picks an end. */
export const DEFAULT_DURATION_MIN = 60;

const MIN = 60_000;

/** Local midnight of the day `ms` falls on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The same clock time as `timeMs`, moved onto the day of `dayMs`. */
export function onDay(dayMs: number, timeMs: number): number {
  const t = new Date(timeMs);
  const d = new Date(dayMs);
  d.setHours(t.getHours(), t.getMinutes(), 0, 0);
  return d.getTime();
}

/** The next whole half hour after `now` — a new draft's default start. */
export function nextHalfHour(now: number): number {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 30 : 60);
  return d.getTime();
}

/** Every start time on the day of `dayMs`, `SLOT_MIN` apart. */
export function startSlots(dayMs: number): number[] {
  const day = startOfDay(dayMs);
  const out: number[] = [];
  for (let m = 0; m < 24 * 60; m += SLOT_MIN) {
    const d = new Date(day);
    d.setHours(0, m, 0, 0);
    out.push(d.getTime());
  }
  return out;
}

/** Every end time after `startMs`, `SLOT_MIN` apart, up to the end of that day. */
export function endSlots(startMs: number): number[] {
  const dayEnd = startOfDay(startMs) + 24 * 60 * MIN;
  const out: number[] = [];
  for (let t = startMs + SLOT_MIN * MIN; t <= dayEnd; t += SLOT_MIN * MIN) out.push(t);
  return out;
}

/** A length in whole minutes split as Google Calendar shows it: 45 分鐘, 1 小時, 1.5 小時. */
export function durationParts(minutes: number): { unit: "min" | "hour"; value: string } {
  if (minutes < 60) return { unit: "min", value: String(minutes) };
  const hours = minutes / 60;
  return { unit: "hour", value: Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, "") };
}

/**
 * The month view's weeks: 6 rows × 7 days (Sunday first), each day as its
 * local-midnight ms, spilling into the neighbouring months to fill the grid.
 */
export function monthGrid(year: number, month: number): number[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const weeks: number[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: number[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d).getTime());
    }
    weeks.push(week);
  }
  return weeks;
}
