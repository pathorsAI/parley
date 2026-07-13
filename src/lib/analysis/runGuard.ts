import { useStore } from "../store";

/**
 * Write-guard for the study runners (analysis / action items / brief /
 * delivery / intel): each runner streams for tens of seconds into the shared
 * store, and two things can invalidate its writes mid-flight —
 *
 *   1. the user loads a DIFFERENT recording (session pin: results must never
 *      land on another session's store/entry), or
 *   2. a NEWER run of the same artifact starts, e.g. "regenerate all"
 *      invalidates a stage while its previous pass still streams
 *      (latest-wins: the stale pass must not clobber the fresh one).
 *
 * One module-level guard per runner; `begin()` at run start returns an
 * `alive()` predicate the runner checks before every store write. Stale runs
 * simply stop writing — their cost is already spent, but they can't corrupt.
 */
export interface RunGuard {
  /** Register a new run; returns its liveness predicate. */
  begin(): () => boolean;
}

export function makeRunGuard(): RunGuard {
  let seq = 0;
  return {
    begin() {
      const mySeq = ++seq;
      const session = useStore.getState().replay?.id ?? null;
      return () =>
        mySeq === seq && (useStore.getState().replay?.id ?? null) === session;
    },
  };
}
