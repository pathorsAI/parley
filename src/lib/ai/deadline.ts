/**
 * Deadlines for model calls that would otherwise wait forever.
 *
 * A study stage (findings, action items, brief, …) is one long model call, and
 * its status doubles as the stage's reentrancy lock. A request that never
 * settles — a provider that accepts the connection and then goes quiet, a
 * stream that stops mid-object — used to leave the stage reading "generating"
 * for good, with every control that could retry it disabled. Every study call
 * now runs under a deadline from here:
 *
 *  - a HARD ceiling on the whole call, and
 *  - an optional STALL timer, reset by `touch()` on every streamed chunk, so a
 *    long answer that keeps arriving is fine but a stream that stops is not.
 *    Before the FIRST chunk it allows longer (`firstOutputMs`): a long
 *    transcript, a busy provider or a reasoning model can legitimately take
 *    minutes to say anything, and only a gap after output started means dead.
 *
 * A deadline can hang off a PARENT signal (the run's own AbortSignal, aborted
 * when the user regenerates a stage that is still running), so cancelling the
 * run aborts the request it is waiting on. `reason()` tells the two apart: a
 * "parent" abort is a cancellation and must not be retried or reported, a
 * "hard"/"stall" one is a timeout the caller may fall back from.
 */

/** Ceiling on one streamed study call (findings, action items, brief). */
export const STUDY_HARD_DEADLINE_MS = 12 * 60_000;
/** How long a streamed study call may take to yield its FIRST output. */
export const STUDY_FIRST_OUTPUT_MS = 5 * 60_000;
/** Once output started, a stream that yields nothing for this long is dead. */
export const STUDY_STALL_MS = 90_000;
/** Ceiling on a non-streamed structured call when the caller sets none. */
export const ONE_SHOT_DEADLINE_MS = 6 * 60_000;
/** Ceiling on the ONE non-streamed retry after a streamed call failed or timed
 *  out. It is a full one-shot call, so it gets the one-shot ceiling — never a
 *  shorter one than the same call would get on its own. */
export const STUDY_FALLBACK_DEADLINE_MS = ONE_SHOT_DEADLINE_MS;
/** Ceiling on the cheap meeting-kind classification before the findings pass. */
export const MEETING_KIND_DEADLINE_MS = 60_000;

/**
 * The longest one study stage can legitimately run: the meeting-kind
 * classification, then the streamed pass up to its hard deadline, then its one
 * non-streamed fallback. The in-flight registry (analysis/runRegistry.ts)
 * derives its ceiling from it so a flight is never forgotten while it may
 * still land.
 */
export const STUDY_MAX_RUN_MS =
  MEETING_KIND_DEADLINE_MS + STUDY_HARD_DEADLINE_MS + STUDY_FALLBACK_DEADLINE_MS;

export type DeadlineReason = "hard" | "stall" | "parent";

/** What a deadline aborts with. Named "TimeoutError" and worded "timed out" so
 *  the error classifiers (ai/errors.ts isTimeoutError, connectionTest) read it
 *  as a timeout however the SDK wraps it. */
export class DeadlineError extends Error {
  readonly reason: Exclude<DeadlineReason, "parent">;
  constructor(reason: Exclude<DeadlineReason, "parent">, ms: number) {
    const secs = Math.round(ms / 1000);
    super(
      reason === "stall"
        ? `The model call timed out: no output for ${secs} s`
        : `The model call timed out after ${secs} s`,
    );
    this.name = "TimeoutError";
    this.reason = reason;
  }
}

export interface Deadline {
  /** Aborts on the hard deadline, the stall timer, or the parent signal. */
  signal: AbortSignal;
  /** Progress was made: restart the stall timer. No-op without one. */
  touch(): void;
  /** Stop the timers and detach from the parent. Idempotent; call when done. */
  clear(): void;
  /** Why the signal aborted, or null while it hasn't. */
  reason(): DeadlineReason | null;
}

export function createDeadline(opts: {
  hardMs: number;
  /** Omit for no stall timer (a non-streamed call has nothing to touch it). */
  stallMs?: number;
  /** The stall window before the first `touch()`. Defaults to `stallMs`. */
  firstOutputMs?: number;
  parent?: AbortSignal;
}): Deadline {
  const { hardMs, stallMs, parent } = opts;
  const firstOutputMs = opts.firstOutputMs ?? stallMs;
  const controller = new AbortController();
  let why: DeadlineReason | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: DeadlineReason, cause: unknown) => {
    if (why) return;
    why = reason;
    clear();
    controller.abort(cause);
  };
  const onParentAbort = () => abort("parent", parent?.reason);

  const hardTimer = setTimeout(() => abort("hard", new DeadlineError("hard", hardMs)), hardMs);
  const armStall = (ms: number | undefined) => {
    if (ms === undefined) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => abort("stall", new DeadlineError("stall", ms)), ms);
  };

  function clear() {
    clearTimeout(hardTimer);
    clearTimeout(stallTimer);
    parent?.removeEventListener("abort", onParentAbort);
  }

  if (parent?.aborted) {
    abort("parent", parent.reason);
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
    armStall(firstOutputMs);
  }

  return {
    signal: controller.signal,
    touch: () => {
      if (!why) armStall(stallMs);
    },
    clear,
    reason: () => why,
  };
}

/**
 * A promise that rejects with the signal's reason once it aborts (and never
 * settles otherwise). Race it against a promise that only settles on success —
 * the AI SDK's `streamObject().object` is one: it never settles at all when the
 * request fails before the stream starts.
 */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Iterate `stream`, giving up the moment `signal` aborts — even when the
 * transport under it ignores the abort and would otherwise keep the loop
 * waiting for a chunk that never comes.
 */
export async function* untilAborted<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = stream[Symbol.asyncIterator]();
  const stop = rejectOnAbort(signal);
  try {
    while (true) {
      const next = await Promise.race([it.next(), stop]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Release the reader; a stream that is already dead may reject this.
    Promise.resolve(it.return?.()).catch(() => {});
  }
}
