// Writes an EXTERNAL analyst (an MCP client) makes to a saved recording: its
// frame (context, speaker names) and its analysis results.

import { useStore } from "../store";
import { log } from "../log";
import type { ActionItem, TimelineEvent } from "../types";
import type { HistoryEntry } from "./types";
import { emitHistoryUpdated, rewriteEntry } from "./entryStore";
import { pushToCloud } from "./cloudPush";

/** The frame fields an MCP client may retarget on a saved recording. */
export interface EntryMetaPatch {
  meetingContext?: string;
  /** Merged per key into the existing map; an empty-string value removes the
   *  custom name for that key (same semantics as the store's setSpeakerName). */
  speakerNames?: Record<string, string>;
}

/**
 * Patch a saved recording's FRAME — free-text context, speaker display names —
 * without touching its analysis. This is how an MCP client describes what kind
 * of meeting a recording was, or fixes a wrong speaker mapping, so every later
 * read and analysis pass gets the right frame. Same read-modify-write as {@link patchEntryOutputs}; the open replay's
 * store is synced so the UI reflects the fix immediately.
 */
export async function updateEntryMeta(id: string, patch: EntryMetaPatch): Promise<HistoryEntry> {
  const updated = await rewriteEntry(id, (meta) => withEntryMeta(meta, patch));
  const s = useStore.getState();
  if (s.loadedHistoryId === id) {
    if (patch.meetingContext !== undefined) s.setMeetingContext(patch.meetingContext);
    for (const [key, name] of Object.entries(patch.speakerNames ?? {})) s.setSpeakerName(key, name);
  }
  await emitHistoryUpdated(id);
  pushToCloud(id); // best-effort; gated by the sync toggle
  log.info("history: entry meta updated", {
    id,
    speakerKeys: Object.keys(patch.speakerNames ?? {}).length,
  });
  return updated;
}

/** A saved entry with an {@link EntryMetaPatch} applied. Pure. */
function withEntryMeta(meta: HistoryEntry, patch: EntryMetaPatch): HistoryEntry {
  const speakerNames = patch.speakerNames
    ? mergeSpeakerNames(meta.speakerNames ?? {}, patch.speakerNames)
    : meta.speakerNames;
  return {
    ...meta,
    ...(patch.meetingContext === undefined ? {} : { meetingContext: patch.meetingContext }),
    speakerNames,
  };
}

/** Empty-string values remove the key; everything else overwrites it. */
function mergeSpeakerNames(
  current: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  const next = { ...current };
  for (const [key, name] of Object.entries(patch)) {
    if (name.trim()) next[key] = name.trim();
    else delete next[key];
  }
  return next;
}

/** The analysis fields an MCP client may replace on a saved recording. */
export interface EntryAnalysisPatch {
  findings?: TimelineEvent[];
  actionItems?: ActionItem[];
  brief?: string | null;
  analyzed?: boolean;
}

/** A saved entry with an {@link EntryAnalysisPatch} applied. Pure. */
function withEntryAnalysis(meta: HistoryEntry, patch: EntryAnalysisPatch): HistoryEntry {
  return {
    ...meta,
    ...(patch.findings ? { findings: patch.findings } : {}),
    ...(patch.actionItems ? { actionItems: patch.actionItems } : {}),
    ...(patch.brief === undefined ? {} : { brief: patch.brief }),
    // An externally written brief supersedes an earlier failed generation.
    ...(patch.brief ? { briefFailed: false } : {}),
    ...(patch.analyzed === undefined ? {} : { analyzed: patch.analyzed }),
  };
}

/**
 * Write analysis results onto a saved recording — the write-back surface for an
 * EXTERNAL analyst (an MCP client doing its own pass over the transcript).
 * Each provided field replaces that whole field; omitted fields are untouched,
 * so a brief write can't clobber findings and vice versa. The rebuilt
 * summary.json keeps the library card's counts (and the `analyzed` flag other
 * clients filter on) honest. Syncs the open replay's store so the timeline
 * re-renders immediately.
 */
export async function setEntryAnalysis(
  id: string,
  patch: EntryAnalysisPatch,
): Promise<{ id: string; findings: number; actionItems: number; brief: boolean; analyzed: boolean | null }> {
  const updated = await rewriteEntry(id, (meta) => withEntryAnalysis(meta, patch));
  const s = useStore.getState();
  if (s.loadedHistoryId === id) {
    if (patch.findings) s.setFindings(patch.findings);
    if (patch.actionItems) s.setActionItems(patch.actionItems);
    if (patch.brief !== undefined) s.setBrief(patch.brief);
  }
  await emitHistoryUpdated(id);
  pushToCloud(id); // best-effort; gated by the sync toggle
  log.info("history: entry analysis written externally", {
    id,
    findings: updated.findings.length,
    actionItems: updated.actionItems.length,
    brief: !!updated.brief,
  });
  return {
    id,
    findings: updated.findings.length,
    actionItems: updated.actionItems.length,
    brief: !!updated.brief,
    analyzed: updated.analyzed ?? null,
  };
}
