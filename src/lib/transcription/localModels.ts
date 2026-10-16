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

/** How well a model suits this machine (judged in Rust, `local_stt::model_fit`). */
export type LocalSttFitLevel = "good" | "slow" | "unsupported";

/** Why a model is not a good fit, most severe first.
 *  - `disk_low`: not enough free disk to download it — the one hard block;
 *  - `ram_low`: total RAM under the model's floor — download needs a confirm;
 *  - `ram_tight`: little memory free right now — a non-blocking note;
 *  - `vram_low`: Vulkan on a discrete GPU with less video memory than the
 *    model wants (`vramNeededBytes`) — a non-blocking note;
 *  - `cpu_only`: a large model without GPU acceleration on a modest CPU. */
export type LocalSttFitReason = "disk_low" | "ram_low" | "ram_tight" | "vram_low" | "cpu_only";

/** How much work a model is to run (Rust `LoadClass`): shown on every card. */
export type LocalSttLoadClass = "light" | "medium" | "heavy";

/** What whisper.cpp decodes on: Metal on Apple Silicon, Vulkan on a Windows PC
 *  with a GPU and a Vulkan driver, else the CPU. */
export type LocalSttAccel = "metal" | "vulkan" | "cpu";

/** Why decoding runs on the CPU (Rust `CpuReason`). */
export type LocalSttCpuReason = "unsupported_platform" | "no_gpu" | "no_vulkan_driver";

export interface LocalSttFit {
  level: LocalSttFitLevel;
  reasons: LocalSttFitReason[];
}

/** One catalog entry, as `local_stt_models` returns it (serde camelCase). */
export interface LocalSttModel {
  id: string;
  family: LocalSttFamily;
  sizeBytes: number;
  /** Downloaded AND SHA-256 verified on disk. */
  installed: boolean;
  /** A download is in flight right now (possibly started from another window). */
  downloading: boolean;
  /** Total RAM below which the model is `ram_low`. */
  minRamBytes?: number;
  /** Free disk its download needs (model + headroom). */
  diskNeededBytes?: number;
  /** Typical resident memory while running (the card's "about N GB RAM"). */
  ramNeededBytes?: number;
  /** Video memory it wants on a discrete GPU (the `vram_low` threshold). */
  vramNeededBytes?: number;
  loadClass?: LocalSttLoadClass;
  /** A large-v3-class model (slow without GPU acceleration). */
  heavy?: boolean;
  /** `null`/absent when the hardware could not be read: fit is unknown, so the
   *  UI shows no fit badge and blocks nothing. */
  fit?: LocalSttFit | null;
}

/** This machine, as `local_stt_hardware` returns it. */
export interface LocalSttHardware {
  totalRamBytes: number;
  availableRamBytes: number;
  /** Free space on the volume holding the models directory. */
  freeDiskBytes: number;
  /** "metal" on Apple Silicon, "vulkan" on a Windows PC with a usable GPU,
   *  "cpu" otherwise (Intel Macs, Linux, Windows without a GPU or driver). */
  accel: LocalSttAccel;
  /** Why `accel` is "cpu"; absent otherwise (and from older backends). */
  cpuReason?: LocalSttCpuReason;
  /** The GPU found — also when it is unused (no Vulkan driver). */
  gpuName?: string;
  /** Its dedicated video memory; absent when unknown (Apple Silicon). */
  gpuVramBytes?: number;
  /** It shares system RAM (integrated GPU, Apple unified memory). */
  gpuShared?: boolean;
  /** Physical cores. */
  cpuCores: number;
  os: string;
  arch: string;
  /** The backend's pick for this machine: the default when it fits well, else
   *  the best whisper model that does; `null` when none does. */
  recommendedId: string | null;
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

/** Emitted (at most once per session) when decoding falls behind real time. */
export const LOCAL_STT_SLOW_EVENT = "local-stt://slow";

/** Payload of {@link LOCAL_STT_SLOW_EVENT}: the model and its median real-time
 *  factor (decode time ÷ audio time; above 0.9 = can't keep up). */
export interface LocalSttSlowPayload {
  model: string;
  rtf: number;
}

/** The Breeze model: the zh-TW default when this machine runs it well. */
export const BREEZE_LOCAL_STT_MODEL = "breeze-asr-25-q5_0";

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

/** `n > 0`, false for NaN — so a missing or garbled number counts as "none". */
function isPositive(n: number): boolean {
  return n > 0;
}

/** Whole-number download percent, clamped to 0–100; 0 when the total is unknown. */
export function downloadPercent(received: number, total: number): number {
  if (!isPositive(total) || !isPositive(received)) return 0;
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
  if (!isPositive(bytes)) return "—";
  const GB = 1_000_000_000;
  const MB = 1_000_000;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

const RAM_ROUNDING = { nearest: Math.round, up: Math.ceil, down: Math.floor } as const;

/**
 * Human RAM size in binary units, labelled "GB" the way an OS shows memory:
 * 8 GiB → "8 GB", 7.7 GiB → "7.7 GB". `round` "up" / "down" for a requirement
 * next to a capacity, so a need of 2.006 GiB against a 2 GiB card reads
 * "2.1 GB" vs "2 GB" rather than "2 GB" vs "2 GB".
 */
export function formatRam(bytes: number, round: keyof typeof RAM_ROUNDING = "nearest"): string {
  if (!isPositive(bytes)) return "—";
  const gib = bytes / 2 ** 30;
  const step = gib >= 10 ? 1 : 10;
  const fn = RAM_ROUNDING[round];
  // Shave float noise (2.5 GiB * 10 must stay 25, not ceil to 26).
  const rounded = fn(Number((gib * step).toFixed(6))) / step;
  return `${rounded} GB`;
}

// ── Hardware fit ───────────────────────────────────────────────────────────

/** What the selected model's Download button does: start it, ask first (too
 *  little RAM — the user may know better), or refuse (no room on disk). An
 *  unknown fit never blocks. */
export type DownloadGate = "ok" | "confirm" | "blocked";

export function downloadGate(fit: LocalSttFit | null | undefined): DownloadGate {
  if (!fit) return "ok";
  if (fit.reasons.includes("disk_low")) return "blocked";
  if (fit.reasons.includes("ram_low")) return "confirm";
  return "ok";
}

/** Badge, tone and the one-line reason for a model card. `null` = fit unknown
 *  (no hardware info): show nothing. */
export interface FitPresentation {
  tone: "success" | "warning" | "danger";
  badge: TranslationKey;
  /** The most severe reason, with its numbers; `null` for a good fit. */
  reason: { key: TranslationKey; vars: Record<string, string> } | null;
}

/** "this Mac" vs "this computer", for the reason lines. */
function deviceKey(hw: LocalSttHardware | null): TranslationKey {
  return hw?.os === "macos" ? "localStt.device.mac" : "localStt.device.pc";
}

export function presentFit(
  model: LocalSttModel,
  hw: LocalSttHardware | null,
  t: (key: TranslationKey) => string,
): FitPresentation | null {
  const fit = model.fit;
  if (!fit) return null;
  const first = fit.reasons[0];
  const device = t(deviceKey(hw));
  let reason: FitPresentation["reason"] = null;
  switch (first) {
    case "disk_low":
      reason = {
        key: "localStt.fit.reason.diskLow",
        vars: {
          need: formatModelSize(model.diskNeededBytes ?? model.sizeBytes),
          free: hw ? formatModelSize(hw.freeDiskBytes) : "—",
        },
      };
      break;
    case "ram_low":
      reason = {
        key: "localStt.fit.reason.ramLow",
        vars: {
          need: formatRam(model.minRamBytes ?? 0),
          have: hw ? formatRam(hw.totalRamBytes) : "—",
          device,
        },
      };
      break;
    case "ram_tight":
      reason = {
        key: "localStt.fit.reason.ramTight",
        vars: { free: hw ? formatRam(hw.availableRamBytes) : "—" },
      };
      break;
    case "vram_low":
      reason = {
        key: "localStt.fit.reason.vramLow",
        vars: {
          need: formatRam(model.vramNeededBytes ?? 0, "up"),
          have: formatRam(hw?.gpuVramBytes ?? 0, "down"),
          gpu: hw?.gpuName ?? t("localStt.device.gpu"),
        },
      };
      break;
    case "cpu_only":
      reason = { key: "localStt.fit.reason.cpuOnly", vars: { device } };
      break;
  }
  if (fit.level === "good") {
    return { tone: "success", badge: "localStt.fit.good", reason: null };
  }
  if (fit.level === "slow") {
    return { tone: "warning", badge: "localStt.fit.slow", reason };
  }
  return {
    tone: "danger",
    badge: fit.reasons.includes("disk_low") ? "localStt.fit.noDisk" : "localStt.fit.noMemory",
    reason,
  };
}

/** One translated piece of a line. */
export interface TextPart {
  key: TranslationKey;
  vars?: Record<string, string>;
}

const LOAD_KEY: Record<LocalSttLoadClass, TranslationKey> = {
  light: "localStt.load.light",
  medium: "localStt.load.medium",
  heavy: "localStt.load.heavy",
};

/**
 * The load hint every model card shows, fit or not: "Light load · about 1 GB
 * RAM", plus "a GPU is recommended" for the large models (`heavy`) when this
 * machine decodes on the CPU. Parts are joined with " · ". `[]` for a backend
 * that sends no load class.
 */
export function presentLoad(model: LocalSttModel, hw: LocalSttHardware | null): TextPart[] {
  if (!model.loadClass) return [];
  const parts: TextPart[] = [{ key: LOAD_KEY[model.loadClass] }];
  if (model.ramNeededBytes) {
    parts.push({ key: "localStt.load.ram", vars: { ram: formatRam(model.ramNeededBytes) } });
  }
  if (model.heavy && hw?.accel === "cpu") parts.push({ key: "localStt.load.gpuRecommended" });
  return parts;
}

/**
 * The picker's acceleration line: "GPU acceleration: <name>" on Metal or
 * Vulkan, else "CPU only" with the reason when the backend gave one. `null`
 * without hardware info.
 */
export function presentAccel(
  hw: LocalSttHardware | null,
  t: (key: TranslationKey) => string,
): { tone: "gpu" | "cpu"; text: TextPart } | null {
  if (!hw) return null;
  if (hw.accel === "metal" || hw.accel === "vulkan") {
    const name = hw.gpuName || t("localStt.accel.gpuUnnamed");
    return { tone: "gpu", text: { key: "localStt.accel.gpu", vars: { name } } };
  }
  switch (hw.cpuReason) {
    case "no_vulkan_driver":
      return {
        tone: "cpu",
        text: { key: "localStt.accel.cpu.noDriver", vars: { gpu: hw.gpuName || t("localStt.device.gpu") } },
      };
    case "no_gpu":
      return { tone: "cpu", text: { key: "localStt.accel.cpu.noGpu" } };
    case "unsupported_platform":
      return { tone: "cpu", text: { key: "localStt.accel.cpu.platform" } };
    default:
      return { tone: "cpu", text: { key: "localStt.accel.cpu" } };
  }
}

/**
 * The model a user who has never picked one should be on, or `null` to leave
 * the setting alone. Never overrides an explicit choice (`chosen`), never moves
 * off a model that is already downloaded, and does nothing without a
 * recommendation. zh-TW users get Breeze when this machine runs it well
 * (Taiwanese Mandarin and code-switching are what it is for); everyone else
 * gets the backend's `recommendedId`.
 */
export function autoLocalModelChoice(input: {
  current: string;
  chosen: boolean;
  models: readonly LocalSttModel[] | null;
  hardware: LocalSttHardware | null;
  language: string;
}): string | null {
  const { current, chosen, models, hardware, language } = input;
  if (chosen || !models || !hardware) return null;
  if (models.find((m) => m.id === current)?.installed) return null;
  const breeze = models.find((m) => m.id === BREEZE_LOCAL_STT_MODEL);
  const target =
    language === "zh-TW" && breeze?.fit?.level === "good" ? breeze.id : hardware.recommendedId;
  if (!target || target === current) return null;
  return models.some((m) => m.id === target) ? target : null;
}

/** The meeting / voice-typing error codes an on-device failure arrives with
 *  (see `local_stt::failure_code` in Rust). */
export type LocalFailureCode = "local" | "local-memory" | "local-missing";

/**
 * The same split for an error MESSAGE (the upload path gets a rejected
 * `transcribe_file`, not a code). Mirrors the markers `local_stt.rs` writes:
 * "not enough memory" and "is not downloaded".
 */
export function localFailureCode(message: string): LocalFailureCode {
  const low = message.toLowerCase();
  if (low.includes("not enough memory")) return "local-memory";
  if (low.includes("is not downloaded")) return "local-missing";
  return "local";
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

/** This machine's memory, free disk, acceleration and the recommended model.
 *  `null` outside Tauri. Rejects when the backend cannot read the hardware;
 *  callers treat that as "fit unknown". */
export async function fetchLocalSttHardware(): Promise<LocalSttHardware | null> {
  if (!isTauri()) return null;
  return invoke<LocalSttHardware>("local_stt_hardware");
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
