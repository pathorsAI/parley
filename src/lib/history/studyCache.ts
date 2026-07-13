// Local cache of GENERATED study outputs for READ-ONLY (org-shared) recordings.
//
// An org recording can't be written back to the shared entry (loadedHistoryId
// stays null so the personal persist paths leave it alone), which used to mean
// every open re-ran — and re-paid for — the whole analysis pipeline. Instead,
// anything that ran gets stored here, keyed by the entry's id, and loadOrgEntry
// folds the cache back into the fetched meta so restored outputs load as "done"
// exactly like an own entry. Storage is localStorage (best-effort, same class
// as the analysis cache in engine.ts); cleared alongside it by the native
// "Clear Cache → Analysis" menu action.

import { readJsonCache, writeJsonCache, clearCacheByPrefix } from "../cache";
import type { ActionItem, DeliveryAssessment, IntelState, MeetingType, TimelineEvent } from "../types";

const PREFIX = "parley:study-cache:";
const key = (entryId: string) => `${PREFIX}${entryId}`;

/** Everything the pipeline generates for a recording. All fields optional — the
 *  cache accretes as each output finishes (a brief finishing must not clobber a
 *  cached intel, mirroring persistStudyOutputs' merge semantics). */
export interface StudyCacheEntry {
  findings?: TimelineEvent[];
  actionItems?: ActionItem[];
  brief?: string | null;
  intel?: IntelState | null;
  deliveryAssessment?: DeliveryAssessment | null;
  meetingType?: MeetingType;
  savedAt?: number;
}

// The pipeline persists several times per run (each settling stage); memoize
// the last merged entry so those writes don't re-parse a large blob each time.
let memoId: string | null = null;
let memoEntry: StudyCacheEntry | null = null;

export function readStudyCache(entryId: string): StudyCacheEntry | null {
  if (memoId === entryId) return memoEntry;
  const entry = readJsonCache<StudyCacheEntry>(key(entryId));
  memoId = entryId;
  memoEntry = entry;
  return entry;
}

/** Merge `patch` over the cached entry; null/undefined fields keep the cached value. */
export function writeStudyCache(entryId: string, patch: StudyCacheEntry): void {
  const prev = readStudyCache(entryId) ?? {};
  const merged: StudyCacheEntry = {
    ...prev,
    findings: patch.findings?.length ? patch.findings : prev.findings,
    actionItems: patch.actionItems?.length ? patch.actionItems : prev.actionItems,
    brief: patch.brief ?? prev.brief ?? null,
    intel: patch.intel ?? prev.intel ?? null,
    deliveryAssessment: patch.deliveryAssessment ?? prev.deliveryAssessment ?? null,
    meetingType: patch.meetingType ?? prev.meetingType,
    savedAt: Date.now(),
  };
  memoId = entryId;
  memoEntry = merged;
  writeJsonCache(key(entryId), merged);
}

/** Drop every cached study output (`parley:study-cache:*`). */
export function clearStudyCache(): number {
  memoId = null;
  memoEntry = null;
  return clearCacheByPrefix(PREFIX);
}
