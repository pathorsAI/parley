/**
 * A tiny beat scheduler: call `onBeat(id)` at each beat's offset (ms from
 * start), in order. Returns a cancel function. Pure setTimeout, so a test can
 * drive it with fake timers.
 */
export interface Beat<Id extends string = string> {
  id: Id;
  /** Offset from the start of the sequence, in ms. */
  at: number;
}

export function runTimeline<Id extends string>(
  beats: readonly Beat<Id>[],
  onBeat: (id: Id, index: number) => void,
): () => void {
  const timers = [...beats]
    .sort((a, b) => a.at - b.at)
    .map((beat, i) => setTimeout(() => onBeat(beat.id, i), Math.max(0, beat.at)));
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}

/**
 * When each of several lines starts typing, and how fast, so that all of them
 * fit in `budgetMs` (never faster to read than `maxMsPerChar` allows… and never
 * slower than it either). Long lines type quicker rather than overrunning the
 * sequence they belong to.
 */
export function typingSchedule(
  lengths: readonly number[],
  budgetMs: number,
  gapMs: number,
  maxMsPerChar: number,
): { msPerChar: number; starts: number[]; endMs: number } {
  const chars = lengths.reduce((a, b) => a + b, 0);
  const gaps = gapMs * Math.max(0, lengths.length - 1);
  const msPerChar = chars > 0 ? Math.min(maxMsPerChar, Math.max(1, (budgetMs - gaps) / chars)) : maxMsPerChar;
  const starts: number[] = [];
  let t = 0;
  for (const len of lengths) {
    starts.push(t);
    t += len * msPerChar + gapMs;
  }
  return { msPerChar, starts, endMs: Math.max(0, t - gapMs) };
}
