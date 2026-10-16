// Opening a saved recording into the replay UI: a personal entry from disk, or
// an org recording fetched read-only from the cloud.

import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { CLOUD_URL, cloudFetch, cloudToken } from "../cloud/client";
import type { ReplaySession } from "../replay/types";
import { withTimingRepaired } from "../replay/timing";
import * as ipc from "../ipc/commands";
import { readStudyCache } from "./studyCache";
import type { HistoryEntry } from "./types";
import { entryWritesSettled, readEntry } from "./entryStore";

/**
 * The replay session for a saved entry. A transcript that synced with no timing
 * at all (#576) gets an estimated timeline here, at the one place every opened
 * recording passes through, so the transcript, seek, findings and brief all
 * read the same clock. Pure + exported for testing.
 */
export function replaySessionFor(meta: HistoryEntry, audioPath: string, audioSrc: string): ReplaySession {
  const { segments, estimated } = withTimingRepaired(meta.segments ?? [], meta.durationMs);
  if (estimated) {
    log.info("history: transcript has no timing; estimating it", {
      id: meta.id,
      segments: segments.length,
      durationMs: meta.durationMs,
    });
  }
  return {
    id: meta.id,
    name: meta.title,
    audioPath,
    audioSrc,
    durationMs: meta.durationMs,
    audioOffsetMs: 0,
    createdAt: meta.createdAt,
    segments,
    speakerNames: meta.speakerNames,
    speechRateHz: meta.speechRateHz ?? null,
    ...(estimated ? { timingEstimated: true } : {}),
  };
}

/**
 * Read a saved entry and load it into the replay UI (restoring its analysis), then
 * focus the main window. Called by the main-window listener on `history://open`.
 */
export async function loadHistoryEntry(id: string): Promise<void> {
  // A stage that finished after the user left may still be writing its result
  // onto this entry — read after it lands, or the open would restore the stale
  // meta and re-run that stage.
  await entryWritesSettled(id);
  const { meta, audioPath } = await readEntry(id);
  const audioSrc = audioPath ? convertFileSrc(audioPath) : "";
  const session = replaySessionFor(meta, audioPath ?? "", audioSrc);
  useStore.getState().loadHistory({ ...meta, segments: session.segments }, session);
  log.info("history: entry loaded", { id, hasAudio: !!audioPath });
  if (isTauri()) {
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      log.warn("history: focus main window failed", { error: String(e) });
    }
  }
}

/**
 * Fold a read-only entry's locally cached study outputs over its fetched meta,
 * filling only what the shared copy lacks (its own saved outputs win).
 */
function foldStudyCache(meta: HistoryEntry, cached: ReturnType<typeof readStudyCache>): void {
  if (!cached) return;
  if (!meta.findings.length && cached.findings?.length) meta.findings = cached.findings;
  if (!meta.actionItems.length && cached.actionItems?.length) meta.actionItems = cached.actionItems;
  // The VIEWER's own completed pass also counts as analyzed — a clean-empty
  // result must restore as done here too, or every open re-spends it.
  if (cached.analyzed) meta.analyzed = true;
  meta.brief = meta.brief || cached.brief || null;
  if (!meta.brief && cached.briefFailed) meta.briefFailed = true;
  meta.deliveryAssessment = meta.deliveryAssessment ?? cached.deliveryAssessment ?? null;
  meta.meetingKind = meta.meetingKind ?? cached.meetingKind ?? null;
}

/**
 * Load an ORG (cloud-shared) recording into replay WITHOUT persisting it to the
 * local history dir — org recordings must never pollute the personal list. The
 * full entry (transcript + analysis) comes over HTTP; the audio is streamed to a
 * temp cache file by Rust (`download_remote_audio`). Loaded read-only so the
 * re-analysis-persist subscription leaves someone else's shared recording alone.
 */
export async function loadOrgEntry(orgId: string, id: string): Promise<void> {
  const base = `/orgs/${encodeURIComponent(orgId)}/recordings/${encodeURIComponent(id)}`;
  const meta = (await (await cloudFetch(`${base}/meta`)).json()) as HistoryEntry;
  // Server meta shapes vary across versions — never trust the arrays to exist.
  meta.findings ??= [];
  meta.actionItems ??= [];
  // Fold locally-cached study outputs over the fetched meta (read-only entries
  // persist there instead of back to the org) so restored outputs load as
  // "done" and the pipeline doesn't re-spend a generation. The shared entry's
  // own saved GENERATED outputs win — the cache only fills what the org copy
  // lacks.
  foldStudyCache(meta, readStudyCache(id));
  let audioPath = "";
  const t = cloudToken();
  if (meta.audio && t) {
    audioPath = await ipc.downloadRemoteAudio({
      id,
      url: `${CLOUD_URL}${base}/audio`,
      token: t,
    });
  }
  const audioSrc = audioPath ? convertFileSrc(audioPath) : "";
  const session = replaySessionFor(meta, audioPath, audioSrc);
  useStore.getState().loadHistory({ ...meta, segments: session.segments }, session, { readOnly: true });
  log.info("history: org entry loaded", { orgId, id, hasAudio: !!audioPath });
  if (isTauri()) {
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      log.warn("history: focus main window failed", { error: String(e) });
    }
  }
}
