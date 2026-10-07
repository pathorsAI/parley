// Which study stages are IN FLIGHT for which recording, and which saved entry a
// replay session belongs to. Pure bookkeeping with no store import, so the store
// itself (loadHistory) can consult it without an import cycle; runGuard.ts is the
// only writer.
//
// Why it exists: a stage (findings, action items, …) runs for 20–60s. When the
// user leaves the recording and comes back while it is still running, loading
// the entry used to reset the stage to "idle" and the scheduler re-dispatched
// it — a second, duplicate model call that superseded the first. With this
// registry loadHistory starts an in-flight stage as "running" instead, and the
// ORIGINAL run (whose session pin matches again) keeps writing into the store.

import { STUDY_MAX_RUN_MS } from "../ai/deadline";

export type StudyStage = "findings" | "actions" | "brief" | "delivery" | "filing";

/** Where a session's outputs persist: its own saved entry on disk, or (for a
 *  read-only org recording) the local study cache keyed by the session id. */
export interface SessionTarget {
  /** The saved personal entry (`loadedHistoryId`), or null when unsaved/read-only. */
  entryId: string | null;
  /** True for a read-only (org-shared) recording. */
  readOnly: boolean;
}

/** A flight older than this is treated as hung: loading its recording ignores it
 *  (the stage restores normally and may re-dispatch, superseding the old run).
 *
 *  Every study model call now runs under a deadline (ai/deadline.ts), so a run
 *  cannot outlive {@link STUDY_MAX_RUN_MS} — classification, the streamed pass
 *  and its one fallback — plus a minute of slack for landing its result. The
 *  ceiling is derived from those deadlines rather than set beside them, so a
 *  restored "running" can never outlast the call it stands for: reopening a
 *  recording whose pass hung used to show "generating" again for ten minutes. */
export const IN_FLIGHT_MAX_AGE_MS = STUDY_MAX_RUN_MS + 60_000;

interface Flight {
  stage: StudyStage;
  token: number;
  startedAt: number;
}

export interface RunRegistry {
  /** Record which entry a replay session currently maps to. */
  recordSession(sessionId: string, target: SessionTarget): void;
  /** The last known persist target of a session (default: unsaved, own). */
  targetOf(sessionId: string): SessionTarget;
  /** The id a session is known by: its saved entry id when it has one (an upload
   *  that auto-saved keeps its upload session id but files as a new entry id),
   *  else the session id itself. Two sessions are "the same recording" exactly
   *  when their canonical ids match. */
  canonical(sessionId: string): string;
  add(sessionId: string, stage: StudyStage, token: number): void;
  remove(sessionId: string, stage: StudyStage, token: number): void;
  /** Stages in flight for a recording (matched by canonical id), excluding flights
   *  older than `maxAgeMs`. */
  stagesFor(id: string, maxAgeMs?: number): Set<StudyStage>;
}

export function createRunRegistry(now: () => number = Date.now): RunRegistry {
  const targets = new Map<string, SessionTarget>();
  const flights = new Map<string, Flight[]>();

  const canonical = (sessionId: string) => targets.get(sessionId)?.entryId ?? sessionId;

  return {
    recordSession(sessionId, target) {
      targets.set(sessionId, { entryId: target.entryId, readOnly: target.readOnly });
    },
    targetOf(sessionId) {
      return targets.get(sessionId) ?? { entryId: null, readOnly: false };
    },
    canonical,
    add(sessionId, stage, token) {
      const list = flights.get(sessionId) ?? [];
      list.push({ stage, token, startedAt: now() });
      flights.set(sessionId, list);
    },
    remove(sessionId, stage, token) {
      const list = flights.get(sessionId);
      if (!list) return;
      const rest = list.filter((f) => !(f.stage === stage && f.token === token));
      if (rest.length) flights.set(sessionId, rest);
      else flights.delete(sessionId);
    },
    stagesFor(id, maxAgeMs = IN_FLIGHT_MAX_AGE_MS) {
      const want = canonical(id);
      const cutoff = now() - maxAgeMs;
      const out = new Set<StudyStage>();
      for (const [sessionId, list] of flights) {
        if (sessionId !== id && canonical(sessionId) !== want) continue;
        for (const f of list) if (f.startedAt >= cutoff) out.add(f.stage);
      }
      return out;
    },
  };
}

/** The app-wide registry (written by runGuard.ts, read by store.loadHistory). */
export const runRegistry = createRunRegistry();

/** Stages still running for this recording — loadHistory restores them as "running". */
export function inFlightStagesFor(id: string): Set<StudyStage> {
  return runRegistry.stagesFor(id);
}
