// Stopped meetings whose recording is still on its way into history.
//
// Stopping a meeting hands the audio to Rust to encode; the history entry is
// written only once Rust reports where the file landed — seconds later on a
// long meeting. The save used to read the LIVE store at that point, so a new
// meeting started in between gave the old recording the new meeting's start
// time and transcript, or had it discarded as empty. Now everything the save
// needs is captured at Stop, keyed by the meeting's id, and the recording
// event looks it up by the id Rust echoes back. Start also waits here (briefly)
// for the previous meeting to finish saving.

interface Pending<T> {
  snapshot: T | null;
  settled: Promise<void>;
  settle: () => void;
}

export class PendingSaves<T> {
  /** Meetings the backend is recording (their start succeeded). Only those
   *  produce a recording event, so only those are waited for. */
  private readonly recording = new Set<string>();
  private readonly pending = new Map<string, Pending<T>>();

  /** The backend started recording meeting `id`. */
  markRecording(id: string): void {
    this.recording.add(id);
  }

  /** Was `id` handed to the backend (and not yet captured)? */
  isRecording(id: string): boolean {
    return this.recording.has(id);
  }

  /** Meeting `id` was cancelled: nothing of it will be saved. */
  forget(id: string): void {
    this.recording.delete(id);
  }

  /** Meeting `id` stopped: keep what its save needs until the recording
   *  arrives. A no-op for a meeting the backend never recorded (a start that
   *  was refused, the dev mock), which no event will ever settle. */
  capture(id: string, snapshot: T): void {
    if (!this.recording.delete(id)) return;
    this.expect(id, snapshot);
  }

  /** Wait for meeting `id`'s recording even though this window never saw it
   *  start (a recording the backend kept making while the page reloaded).
   *  `snapshot` is what to save it with. */
  expect(id: string, snapshot: T | null): void {
    const existing = this.pending.get(id);
    if (existing) {
      // What was captured at its Stop is the better record.
      existing.snapshot = existing.snapshot ?? snapshot;
      return;
    }
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pending.set(id, { snapshot, settled, settle });
  }

  /** The recording for `id` arrived: what was captured for it (null when
   *  nothing was). The entry stays pending until {@link settle}. */
  snapshotOf(id: string): T | null {
    return this.pending.get(id)?.snapshot ?? null;
  }

  /** Meeting `id`'s save is over, kept or not. */
  settle(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.settle();
  }

  /** Is any stopped meeting still being saved? */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Resolve once every meeting pending NOW has settled, or after
   *  `timeoutMs`; `true` = they all settled. The snapshot keeps a late save
   *  correct either way — the wait only keeps the two meetings' work from
   *  overlapping on screen. */
  async whenSettled(timeoutMs: number): Promise<boolean> {
    const all = Promise.all([...this.pending.values()].map((p) => p.settled)).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
