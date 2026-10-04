import { useStore } from "../store";
import { log } from "../log";
import { runRegistry, type StudyStage } from "./runRegistry";
import type { StageOutputPatch } from "../history/history";

/**
 * Lifecycle of one study-runner pass (analysis / action items / brief /
 * delivery / filing). Each runner streams for tens of seconds into the shared
 * store, and the world can change under it:
 *
 *   1. the user LEAVES the recording (opens another one, exits replay). The
 *      run must stop writing into the store — those results must never land on
 *      another recording — but its finished result is still this recording's,
 *      so it is written onto the recording's saved entry instead (see
 *      {@link landStage}). Throwing it away is what made reopening a recording
 *      start the whole analysis over.
 *   2. the user COMES BACK while the run is still going. Loading the entry
 *      consults the in-flight registry (runRegistry.ts) and starts this stage
 *      as "running", and the run — whose recording is on screen again — simply
 *      resumes writing into the store. No duplicate model call.
 *   3. a NEWER run of the same stage starts for the same recording, e.g.
 *      "regenerate all" invalidates a stage while its previous pass still
 *      streams. Latest wins: the older run is SUPERSEDED and its result is
 *      dropped — never written to the store and never persisted.
 *
 * One module-level guard per runner; `begin()` at run start returns a handle
 * the runner checks before every store write and ends exactly once.
 */
export interface RunHandle {
  /** May this run write into the store right now? Its recording is the one on
   *  screen and no newer run of the same stage has started for it. */
  alive(): boolean;
  /** A newer run of the same stage started for the same recording. */
  superseded(): boolean;
  /** Where this run's output persists when it can't go through the store. */
  target(): RunTarget;
  /** Leave the in-flight registry. Idempotent; call in `finally`. */
  end(): void;
}

export interface RunTarget {
  /** The saved personal entry this run is for (null: unsaved / read-only / live). */
  entryId: string | null;
  /** The read-only org recording this run is for (study-cache key), else null. */
  readOnlyId: string | null;
}

export interface RunGuard {
  /** Register a new run; returns its handle. */
  begin(): RunHandle;
}

// Keep the session → saved-entry mapping current. A fresh upload auto-saves
// under a NEW entry id while its replay session keeps the upload's id, so this
// is how a run started before the save still knows which entry it belongs to
// after the user has left. Installed lazily (on the first run), and it records
// the state at install time, so nothing a run needs is missed.
let watching = false;
type StoreState = ReturnType<typeof useStore.getState>;
function recordSession(s: StoreState): void {
  // A live meeting leaves the previous replay session in place but clears
  // loadedHistoryId — that is not this session's entry changing.
  if (!s.replay || s.appMode === "live") return;
  runRegistry.recordSession(s.replay.id, {
    entryId: s.loadedHistoryId,
    readOnly: s.replayReadOnly,
  });
}
function watchSessions(): void {
  if (watching) return;
  watching = true;
  recordSession(useStore.getState());
  useStore.subscribe((s, p) => {
    if (
      s.replay !== p.replay ||
      s.appMode !== p.appMode ||
      s.loadedHistoryId !== p.loadedHistoryId ||
      s.replayReadOnly !== p.replayReadOnly
    ) {
      recordSession(s);
    }
  });
}

/** Which recording a session id is: live mode (no session) is its own key. */
function keyOf(session: string | null): string {
  return session === null ? "" : `r:${runRegistry.canonical(session)}`;
}

/** The recording whose study state the store holds. Library/home navigation
 *  keeps the replay loaded (and returns to it intact), so it still counts; a
 *  live meeting does not — startMeeting wipes the study slice for the meeting
 *  while leaving `replay` set, and a replay pass must not write into that. */
function currentSession(): string | null {
  const s = useStore.getState();
  return s.appMode === "live" ? null : s.replay?.id ?? null;
}

export function makeRunGuard(stage: StudyStage): RunGuard {
  let seq = 0;
  // Runs this guard began that could still supersede an in-flight one. Pruned
  // to the oldest in-flight token, so it stays a handful of entries.
  const begun: { token: number; session: string | null }[] = [];
  const inFlight = new Set<number>();

  const prune = () => {
    if (!inFlight.size) {
      begun.length = 0;
      return;
    }
    const oldest = Math.min(...inFlight);
    for (let i = begun.length - 1; i >= 0; i--) if (begun[i].token < oldest) begun.splice(i, 1);
  };

  return {
    begin() {
      watchSessions();
      const token = ++seq;
      const session = currentSession();
      begun.push({ token, session });
      inFlight.add(token);
      if (session !== null) runRegistry.add(session, stage, token);
      let ended = false;

      const superseded = () =>
        begun.some((r) => r.token > token && keyOf(r.session) === keyOf(session));

      return {
        superseded,
        alive: () => !superseded() && keyOf(currentSession()) === keyOf(session),
        target: () => {
          if (session === null) return { entryId: null, readOnlyId: null };
          const t = runRegistry.targetOf(session);
          return t.readOnly
            ? { entryId: null, readOnlyId: session }
            : { entryId: t.entryId, readOnlyId: null };
        },
        end: () => {
          if (ended) return;
          ended = true;
          inFlight.delete(token);
          if (session !== null) runRegistry.remove(session, stage, token);
          prune();
        },
      };
    },
  };
}

/**
 * Land a settled pass — success or failure — exactly once:
 *
 *  - recording still on screen → `apply()` the store writes (and, with
 *    `persistWhileLoaded`, also write `patch` onto the entry / study cache);
 *  - user left it → write `patch` onto that recording's entry (or the read-only
 *    study cache) so the next open restores it instead of re-running it, and
 *    if the user came BACK while that write ran, `apply()` too — loading the
 *    entry showed this stage "running" because it was still in flight;
 *  - superseded by a newer run → drop it.
 *
 * The run leaves the in-flight registry in the same synchronous step as that
 * decision, so loading the entry sees either "still running, will apply" or the
 * persisted result — never a gap where the stage would re-dispatch, and never a
 * "running" stage nobody will finish. A detached write completes before the run
 * leaves the registry for the same reason.
 */
export async function landStage(
  run: RunHandle,
  opts: {
    stage: StudyStage;
    apply: () => void;
    /** What this pass produced, as entry fields. null: nothing to keep. */
    patch: StageOutputPatch | null;
    /** Also persist `patch` while the recording is still loaded (stages that have
     *  no other persist hook: brief, delivery, filing, the early findings write). */
    persistWhileLoaded?: boolean;
    /** Push to the cloud on a while-loaded write (default true). The early
     *  findings write skips it: the action-items write follows within seconds
     *  and pushes the newer content (each push re-uploads the audio). */
    pushWhileLoaded?: boolean;
  },
): Promise<void> {
  const { stage, apply, patch } = opts;
  if (run.alive()) {
    apply();
    run.end();
    if (opts.persistWhileLoaded && patch) {
      await persist(stage, run.target(), patch, opts.pushWhileLoaded ?? true);
    }
    return;
  }
  if (run.superseded() || !patch) {
    run.end();
    return;
  }
  const target = run.target();
  if (target.entryId || target.readOnlyId) {
    await persist(stage, target, patch, true);
    log.info("study: stage result kept after leaving the recording", {
      stage,
      entryId: target.entryId ?? target.readOnlyId,
    });
  }
  if (run.alive()) apply();
  run.end();
}

async function persist(
  stage: StudyStage,
  target: RunTarget,
  patch: StageOutputPatch,
  push: boolean,
): Promise<void> {
  if (!target.entryId && !target.readOnlyId) return;
  try {
    const m = await import("../history/history");
    await m.persistStageOutputs(target, patch, { push });
  } catch (e) {
    log.warn("study: stage persist failed", { stage, error: String(e) });
  }
}
