import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import type { TranslationKey } from "../../i18n/messages";

/**
 * On-device transcription (whisper.cpp) — the frontend half of the "local"
 * STT provider. The model CATALOG (ids, sizes, download URLs, checksums) is
 * owned by Rust and listed by `local_stt_models`; this side only owns display
 * text (keyed by model id in i18n) and the one readiness rule every surface
 * shares: a local model can be selected before it is downloaded, but nothing
 * may start (meeting, voice typing, upload, onboarding's Next) until it is
 * fully downloaded and verified. See docs/design/local-stt.md.
 */

export type LocalSttFamily = "whisper" | "breeze";

/** One catalog entry, as `local_stt_models` returns it (serde camelCase). */
export interface LocalSttModel {
  id: string;
  family: LocalSttFamily;
  sizeBytes: number;
  /** Downloaded AND SHA-256 verified on disk. */
  installed: boolean;
  /** A download is in flight right now (possibly started from another window). */
  downloading: boolean;
}

export type LocalSttStage = "downloading" | "verifying" | "done" | "error" | "cancelled";

/** Payload of the {@link LOCAL_STT_PROGRESS_EVENT} event. */
export interface LocalSttProgress {
  modelId: string;
  stage: LocalSttStage;
  received: number;
  total: number;
  message?: string;
}

export const LOCAL_STT_PROGRESS_EVENT = "local-stt://progress";

/** Recommended default: fast, accurate, multilingual, and a moderate download. */
export const DEFAULT_LOCAL_STT_MODEL = "whisper-large-v3-turbo-q5_0";

/**
 * Credential sentinel for the local provider. It has no key, but every start
 * path gates on `sttApiKey(...).trim()` being non-empty; passing this keeps
 * those gates uniform while the real readiness check is {@link isLocalModelReady}.
 */
export const LOCAL_STT_API_KEY = "local";

/** Per-model download state in the UI. Absent from the map = idle. */
export type LocalDownloadState =
  | { status: "downloading"; received: number; total: number }
  | { status: "verifying" }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export type LocalDownloads = Readonly<Record<string, LocalDownloadState>>;

/**
 * Fold one progress event into the per-model download map. Pure, so the hook
 * and the tests share it. `done` clears the entry (the refreshed catalog then
 * reports `installed`); `error` / `cancelled` stick until the next attempt so
 * the UI can offer a retry.
 */
export function reduceLocalProgress(state: LocalDownloads, ev: LocalSttProgress): LocalDownloads {
  const next: Record<string, LocalDownloadState> = { ...state };
  switch (ev.stage) {
    case "downloading":
      next[ev.modelId] = { status: "downloading", received: ev.received, total: ev.total };
      break;
    case "verifying":
      next[ev.modelId] = { status: "verifying" };
      break;
    case "done":
      delete next[ev.modelId];
      break;
    case "error":
      next[ev.modelId] = { status: "error", message: ev.message ?? "" };
      break;
    case "cancelled":
      next[ev.modelId] = { status: "cancelled" };
      break;
  }
  return next;
}

/** Whole-number download percent, clamped to 0–100; 0 when the total is unknown. */
export function downloadPercent(received: number, total: number): number {
  if (!(total > 0) || !(received > 0)) return 0;
  return Math.min(100, Math.floor((received / total) * 100));
}

/** A download (or its verification) is in flight for this model. */
export function isLocalBusy(
  models: readonly LocalSttModel[] | null,
  downloads: LocalDownloads,
  modelId: string,
): boolean {
  const d = downloads[modelId];
  if (d && (d.status === "downloading" || d.status === "verifying")) return true;
  return !!models?.find((m) => m.id === modelId)?.downloading;
}

/** Any model is downloading or verifying. */
export function anyLocalBusy(models: readonly LocalSttModel[] | null, downloads: LocalDownloads): boolean {
  const ids = new Set([...(models ?? []).map((m) => m.id), ...Object.keys(downloads)]);
  return [...ids].some((id) => isLocalBusy(models, downloads, id));
}

/**
 * THE readiness rule: the selected model exists in the catalog, is installed,
 * and is not being (re)downloaded. An unknown catalog (`null`, still loading or
 * the command failed) is not ready — fail closed.
 */
export function isLocalModelReady(models: readonly LocalSttModel[] | null, modelId: string): boolean {
  const m = models?.find((x) => x.id === modelId);
  return !!m && m.installed && !m.downloading;
}

/**
 * Human size for a byte count, decimal units (what download pages quote):
 * "190 MB", "574 MB", "1.08 GB". Sub-MB sizes round up to "1 MB".
 */
export function formatModelSize(bytes: number): string {
  if (!(bytes > 0)) return "—";
  const GB = 1_000_000_000;
  const MB = 1_000_000;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

/** i18n keys for a model's name and one-line description. Unknown ids (a
 *  catalog entry added in Rust before the frontend learned it) fall back to the
 *  raw id via {@link localModelLabel}. */
const MODEL_TEXT: Record<string, { name: TranslationKey; desc: TranslationKey }> = {
  "whisper-small-q5_1": {
    name: "localStt.model.whisperSmall.name",
    desc: "localStt.model.whisperSmall.desc",
  },
  "whisper-large-v3-turbo-q5_0": {
    name: "localStt.model.whisperTurbo.name",
    desc: "localStt.model.whisperTurbo.desc",
  },
  "whisper-large-v3-turbo-q8_0": {
    name: "localStt.model.whisperTurboQ8.name",
    desc: "localStt.model.whisperTurboQ8.desc",
  },
  "breeze-asr-25-q5_0": {
    name: "localStt.model.breeze.name",
    desc: "localStt.model.breeze.desc",
  },
};

export function localModelLabel(
  t: (key: TranslationKey) => string,
  modelId: string,
): { name: string; description: string | null } {
  const text = MODEL_TEXT[modelId];
  return text ? { name: t(text.name), description: t(text.desc) } : { name: modelId, description: null };
}

/** Catalog order for display: the recommended default first, then by size. */
export function sortLocalModels(models: readonly LocalSttModel[]): LocalSttModel[] {
  return [...models].sort((a, b) => {
    if (a.id === DEFAULT_LOCAL_STT_MODEL) return -1;
    if (b.id === DEFAULT_LOCAL_STT_MODEL) return 1;
    return a.sizeBytes - b.sizeBytes;
  });
}

// ── IPC wrappers ──────────────────────────────────────────────────────────

/** The catalog with on-disk state. Outside Tauri (plain-browser dev) there is
 *  no backend, so the list is empty and nothing local is ever ready. */
export async function fetchLocalSttModels(): Promise<LocalSttModel[]> {
  if (!isTauri()) return [];
  return invoke<LocalSttModel[]>("local_stt_models");
}

/** Resolves once downloaded AND checksum-verified; rejects with a string error. */
export function downloadLocalSttModel(modelId: string): Promise<void> {
  return invoke<void>("local_stt_download", { modelId });
}

export function cancelLocalSttDownload(modelId: string): Promise<void> {
  return invoke<void>("local_stt_cancel", { modelId });
}

export function deleteLocalSttModel(modelId: string): Promise<void> {
  return invoke<void>("local_stt_delete", { modelId });
}

/**
 * One-shot readiness check for the start gates (meeting, voice typing,
 * upload). A failed catalog call counts as not ready.
 */
export async function checkLocalModelReady(modelId: string): Promise<boolean> {
  try {
    return isLocalModelReady(await fetchLocalSttModels(), modelId);
  } catch {
    return false;
  }
}
