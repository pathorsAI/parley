/**
 * The bundled sample recording: a short scripted sales call that onboarding can
 * drop into the library so a new user sees transcript, analysis, replay and MCP
 * working before they record anything.
 *
 * The sample becomes a REAL library entry (source "upload", analyzed: false) so
 * every downstream path — filing suggestion, the analysis pipeline, replay, MCP —
 * treats it exactly like a user's own upload. The only special cases keyed on
 * {@link isSampleEntry} are that it is never pushed to the user's cloud account
 * (see cloud/sync.ts) and that loading it twice doesn't duplicate it.
 *
 * Assets are rendered by scripts/sample/render.ts: the audio lives in
 * public/sample/ (served from the app origin, so `/sample/…` resolves under
 * both `tauri://localhost` and `http://tauri.localhost`), the timed manifests
 * are mirrored into ./sampleManifests/ so they can be imported as JSON modules.
 */
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { buildSummary, emitHistoryUpdated, listHistory } from "../history/history";
import type { HistoryEntry } from "../history/types";
import { log } from "../log";
import { isTauri } from "../platform";
import { useStore } from "../store";
import type { AppLanguage, MeetingKind, TranscriptSegment } from "../types";
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

/** Map a manifest onto the history entry the library stores. Pure. */
export function buildSampleEntry(manifest: SampleManifest, createdAt: number): HistoryEntry {
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
  return {
    id: manifest.id,
    title: manifest.title,
    source: "upload",
    createdAt,
    durationMs: manifest.durationMs,
    segments,
    speakerNames,
    findings: [],
    actionItems: [],
    analyzed: false,
    meetingContext: manifest.context,
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: "audio.ogg",
    folderId: null,
    meetingKind: kind,
    filingSuggestion: null,
    filingSuggested: false,
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

    const entry = buildSampleEntry(manifest, Date.now());
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
