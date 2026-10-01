/**
 * The bundled sample recording: a short scripted sales call that onboarding can
 * drop into the library so a new user sees transcript, analysis, replay and MCP
 * working before they record anything.
 *
 * The sample becomes a REAL library entry (source "upload") so replay, filing,
 * copy and MCP treat it exactly like a user's own upload. It arrives ALREADY
 * analysed and ALREADY suggested: the manifest carries a prewritten filing
 * suggestion (title + a new folder), a brief, findings and action items, and the
 * entry is saved with `analyzed: true` / `filingSuggested: true`. That is what
 * the first lap has to show — the rename-and-file moment and a report with
 * content — and it must not depend on a model, a key or a network. Because both
 * flags are set, the study pipeline restores those stages as "done" on load and
 * never re-spends them on the sample (see store.loadHistory / studyPipeline).
 *
 * The other special cases keyed on {@link isSampleEntry} are that it is never
 * pushed to the user's cloud account (see cloud/sync.ts) and that loading it
 * twice doesn't duplicate it.
 *
 * Assets are rendered by scripts/sample/render.ts: the audio lives in
 * public/sample/ (served from the app origin, so `/sample/…` resolves under
 * both `tauri://localhost` and `http://tauri.localhost`), the timed manifests
 * are mirrored into ./sampleManifests/ so they can be imported as JSON modules.
 */
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { buildSummary, emitHistoryUpdated, listHistory } from "../history/history";
import { filingChoices, listLocalFolders, type Folder } from "../history/folders";
import type { HistoryEntry, HistoryEntrySummary } from "../history/types";
import { log } from "../log";
import { isTauri } from "../platform";
import { useStore } from "../store";
import type {
  ActionItem,
  AppLanguage,
  FilingFolderSuggestion,
  FilingSuggestion,
  MeetingKind,
  TimelineEvent,
  TranscriptSegment,
} from "../types";
import { translate } from "../../i18n/messages";
import { markGettingStarted } from "./gettingStarted";
import enManifestJson from "./sampleManifests/sample.en.json";
import zhManifestJson from "./sampleManifests/sample.zh-TW.json";

type SampleSide = "me" | "them";

/** The rendered manifest written by scripts/sample/render.ts. */
export interface SampleManifest {
  id: string;
  lang: AppLanguage;
  title: string;
  /** Audio file name under public/sample/. */
  audio: string;
  durationMs: number;
  meetingKind: string;
  context: string;
  speakers: Record<SampleSide, string>;
  segments: { speaker: SampleSide; startMs: number; endMs: number; text: string }[];
  questions: string[];
  mcpQuestions: string[];
  /** The prewritten filing suggestion: a better title and a folder to create. */
  suggestion: { title: string; folders: { name: string; reason: string }[] };
  /** The prewritten brief (markdown, with [m:ss] timestamps). */
  brief: string;
  findings: {
    atMs: number;
    side: SampleSide;
    severity: TimelineEvent["severity"];
    title: string;
    detail: string;
    quotes: string[];
  }[];
  actionItems: { text: string; atMs: number }[];
}

const MANIFESTS: Record<AppLanguage, SampleManifest> = {
  "zh-TW": zhManifestJson as SampleManifest,
  en: enManifestJson as SampleManifest,
};

/** The manifest for a UI language (anything but zh-TW gets English). */
export function sampleManifest(lang: AppLanguage): SampleManifest {
  return lang === "zh-TW" ? MANIFESTS["zh-TW"] : MANIFESTS.en;
}

/**
 * How each side is keyed in the transcript. The user's side is the primary mic
 * voice ("me", speaker 1 → default label "You", the blue identity dot, and the
 * side delivery coaching reads); the counterpart is a remote speaker ("them",
 * speaker 1). Keys therefore come out as `me-1` / `them-1` via `speakerKey()` —
 * the same shape a live meeting produces.
 */
const SIDE_SEGMENT: Record<SampleSide, Pick<TranscriptSegment, "source" | "speaker">> = {
  me: { source: "me", speaker: 1 },
  them: { source: "them", speaker: 1 },
};

const MEETING_KINDS: readonly MeetingKind[] = ["internal", "sales", "pricing", "rivalry"];

/** The filing suggestion can offer at most this many folder chips. */
const MAX_FOLDER_CHIPS = 3;
/** …of which at most this many point at folders the user already has. */
const MAX_EXISTING_CHIPS = 2;

/**
 * The sample's filing suggestion: the manifest's title, its folder as a NEW
 * folder chip, then up to two of the user's own folders (most recently used
 * first) so the card shows a real choice rather than a single button. A live
 * folder that already carries the manifest folder's name is pointed at instead
 * of being created twice. Pure.
 */
export function sampleFilingSuggestion(
  manifest: SampleManifest,
  existing: readonly Pick<Folder, "id" | "name">[] = [],
): FilingSuggestion {
  const folders: FilingFolderSuggestion[] = manifest.suggestion.folders.map((f) => ({
    folderId: existing.find((e) => e.name.trim() === f.name.trim())?.id ?? null,
    name: f.name,
    reason: f.reason,
  }));
  const reason = translate(manifest.lang, "filing.reason.existing");
  const taken = new Set(folders.map((f) => f.folderId).filter((id) => id !== null));
  const extra = existing
    .filter((f) => !taken.has(f.id))
    .slice(0, MAX_EXISTING_CHIPS)
    .map((f): FilingFolderSuggestion => ({ folderId: f.id, name: f.name, reason }));
  return {
    title: manifest.suggestion.title,
    folders: [...folders, ...extra].slice(0, MAX_FOLDER_CHIPS),
  };
}

/**
 * The user's live personal folders, most recently USED first — "used" meaning
 * the newest recording filed there; folders nothing is filed in yet follow,
 * newest first. `library` is the summary list (any order).
 */
export function recentFolders(
  folders: readonly Folder[],
  library: readonly Pick<HistoryEntrySummary, "folderId" | "createdAt">[],
): Folder[] {
  const live = filingChoices(folders);
  const lastUsed = new Map<string, number>();
  for (const e of library) {
    if (!e.folderId) continue;
    lastUsed.set(e.folderId, Math.max(lastUsed.get(e.folderId) ?? 0, e.createdAt));
  }
  return [...live].sort(
    (a, b) =>
      (lastUsed.get(b.id) ?? -1) - (lastUsed.get(a.id) ?? -1) || b.createdAt - a.createdAt,
  );
}

/**
 * Map a manifest onto the history entry the library stores. Pure. `folders` are
 * the user's existing folders, most recently used first (see
 * {@link recentFolders}), offered after the manifest's new folder.
 */
export function buildSampleEntry(
  manifest: SampleManifest,
  createdAt: number,
  folders: readonly Pick<Folder, "id" | "name">[] = [],
): HistoryEntry {
  const segments: TranscriptSegment[] = manifest.segments.map((s, i) => ({
    id: `${manifest.id}-${i}`,
    ...SIDE_SEGMENT[s.speaker],
    text: s.text,
    isFinal: true,
    startMs: s.startMs,
    endMs: s.endMs,
  }));
  const speakerNames: Record<string, string> = {};
  for (const side of ["me", "them"] as const) {
    const { source, speaker } = SIDE_SEGMENT[side];
    speakerNames[`${source}-${speaker}`] = manifest.speakers[side];
  }
  const kind = MEETING_KINDS.find((k) => k === manifest.meetingKind) ?? null;
  const findings: TimelineEvent[] = manifest.findings.map((f, i) => ({
    id: `sample-f-${i}`,
    atMs: f.atMs,
    side: f.side,
    severity: f.severity,
    source: "extra",
    title: f.title,
    detail: f.detail,
    quotes: [...f.quotes],
  }));
  const actionItems: ActionItem[] = manifest.actionItems.map((a, i) => ({
    id: `sample-a-${i}`,
    text: a.text,
    done: false,
    linkedEventId: null,
    atMs: a.atMs,
  }));
  return {
    id: manifest.id,
    title: manifest.title,
    source: "upload",
    createdAt,
    durationMs: manifest.durationMs,
    segments,
    speakerNames,
    findings,
    actionItems,
    analyzed: true,
    brief: manifest.brief,
    meetingContext: manifest.context,
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: "audio.ogg",
    folderId: null,
    meetingKind: kind,
    filingSuggestion: sampleFilingSuggestion(manifest, folders),
    filingSuggested: true,
  };
}

/** Collapses a double-click into one load (both callers get the same id). */
let inFlight: Promise<string | null> | null = null;

/**
 * Loads the bundled sample recording into the library as a real entry and
 * returns its history id, or null when unavailable (outside Tauri, or on
 * failure — which also toasts). Idempotent: when the sample for the current
 * language is already in the library, returns its id without rewriting it.
 */
export async function loadSampleRecording(): Promise<string | null> {
  inFlight ??= loadOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function loadOnce(): Promise<string | null> {
  if (!isTauri()) return null;
  const lang = useStore.getState().settings.language;
  const manifest = sampleManifest(lang);
  try {
    const existing = await listHistory();
    if (existing.some((e) => e.id === manifest.id)) {
      markGettingStarted("recorded");
      return manifest.id;
    }

    const res = await fetch(`/sample/${manifest.audio}`);
    if (!res.ok) throw new Error(`sample audio ${res.status}`);
    const audio = new Uint8Array(await res.arrayBuffer());

    const entry = buildSampleEntry(manifest, Date.now(), recentFolders(listLocalFolders(), existing));
    // Audio first, then meta/summary — a summary claiming hasAudio must always
    // have its audio.ogg (the same order every other save path keeps).
    await invoke("write_sample_audio", audio, { headers: { "x-entry-id": entry.id } });
    await invoke("save_history_entry", {
      id: entry.id,
      summaryJson: JSON.stringify(buildSummary(entry)),
      metaJson: JSON.stringify(entry),
      audioSourcePath: null,
      compress: false,
    });
    // Deliberately no markDirty / cloud push: the sample never leaves the device.
    log.info("sample: loaded into library", { id: entry.id, lang });
    await emitHistoryUpdated(entry.id).catch(() => {});
    markGettingStarted("recorded");
    return entry.id;
  } catch (e) {
    log.error("sample: load failed", { error: String(e) });
    toast.error(translate(lang, "home.sampleFailed", { error: String(e) }));
    return null;
  }
}

/** Sample entries are recognised by their id prefix. */
export function isSampleEntry(entry: { id: string }): boolean {
  return entry.id.startsWith("sample-");
}

/** The suggested questions to show after the sample loads (in-app and for an
 *  external AI over MCP), for a UI language. Synchronous: bundled data. */
export function sampleQuestions(lang: AppLanguage): { questions: string[]; mcpQuestions: string[] } {
  const m = sampleManifest(lang);
  return { questions: [...m.questions], mcpQuestions: [...m.mcpQuestions] };
}
