//! On-device speech recognition models for the "local" STT provider.
//!
//! The provider runs whisper.cpp (via `whisper-rs`) entirely on this machine,
//! so the only network traffic is the one-time model download handled here.
//! This module owns:
//! - the model catalog ([`CATALOG`]): one row per downloadable GGML model;
//! - where models live (`app_data_dir()/models/stt/` — deliberately NOT the app
//!   cache dir, whose "Clear all" must never delete a gigabyte of model);
//! - the download flow (stream to `<file>.part`, verify size + SHA-256, then an
//!   atomic rename), its progress events and cancellation;
//! - the loaded-model cache shared by every session (meeting mic + system audio,
//!   voice typing, file transcription), and the leases that keep a model from
//!   being deleted while a session uses it;
//! - what whisper.cpp decodes on ([`accel_choice`]): Metal on Apple Silicon,
//!   Vulkan on a Windows PC with a GPU and a Vulkan driver, else the CPU;
//! - the hardware fit of each model ([`model_fit`]): whether this machine has
//!   the memory, the disk and the acceleration to run it (probes in
//!   `hardware.rs`), and the real-time-factor warning a live session raises
//!   when decoding cannot keep up ([`SLOW_EVENT`]).
//!
//! The recognizer itself lives in `transcription/local.rs`.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{WhisperContext, WhisperContextParameters};

/// Event the Settings UI listens on for download progress.
pub const PROGRESS_EVENT: &str = "local-stt://progress";

/// Event a session emits (at most once) when decoding falls behind real time;
/// payload `{ model, rtf }`. See `transcription::local::RtfTracker`.
pub const SLOW_EVENT: &str = "local-stt://slow";

/// Metal is used on Apple Silicon only: Intel Macs have the `metal` feature
/// compiled in (Cargo cannot split macOS by arch in a universal build), but
/// their integrated GPUs are no faster than the CPU, so they decode on the CPU.
const APPLE_SILICON: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

/// The build carries ggml's Vulkan backend: Windows (see the Windows
/// `whisper-rs` entry in Cargo.toml — this must match its cfg).
pub const VULKAN_BUILD: bool = cfg!(target_os = "windows");

const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;

/// The model used when a caller does not name one.
pub const DEFAULT_MODEL_ID: &str = "whisper-large-v3-turbo-q5_0";

/// Which model family a catalog entry belongs to. Drives prompting: Breeze is
/// a Taiwanese-Mandarin fine-tune and is always steered toward Traditional
/// Chinese output (see `transcription/local.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    Whisper,
    Breeze,
}

/// How much work a model is to run, for the hint every model card shows before
/// download. Decided by the decoder, not the file size: whisper's cost per
/// second of audio is one encoder pass plus one decoder pass per token.
/// - `light`: small (12 encoder / 12 decoder layers of width 768).
/// - `medium`: large-v3 turbo, at either quantization — the full large-v3
///   encoder, but a 4-layer decoder, so token by token it costs about an
///   eighth of a full large model. q8_0 only adds weight bytes, not work.
/// - `heavy`: Breeze-ASR-25, a large-v2 fine-tune with the full 32-layer
///   decoder: the most work per token and the most memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoadClass {
    Light,
    Medium,
    Heavy,
}

/// One downloadable model. `sha256` is the Hugging Face LFS oid, which is the
/// SHA-256 of the file itself.
#[derive(Debug)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub family: ModelFamily,
    /// Hugging Face repository (`owner/name`).
    pub repo: &'static str,
    /// File name inside the repository, also the name on disk.
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// Total RAM below which the UI says "not enough memory" (a soft block).
    pub min_ram_bytes: u64,
    /// Typical resident memory while a meeting runs on it (weights plus the two
    /// sessions' decoding states; see the budget on [`CATALOG`]). Shown on
    /// every card; the fit rules use `min_ram_bytes` and the model size.
    pub ram_needed_bytes: u64,
    /// The card's load hint (see [`LoadClass`]).
    pub load_class: LoadClass,
    /// A large-v3-class encoder (turbo, Breeze): too slow for live use without
    /// GPU acceleration unless the CPU is strong.
    pub heavy: bool,
}

impl CatalogEntry {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/main/{}",
            self.repo, self.file
        )
    }
}

/// Every model the app offers. Adding a model is one row here (plus its
/// display strings in the frontend).
///
/// `min_ram_bytes` budget: a live meeting runs TWO sessions (mic and system
/// audio), each with its own `WhisperState`, on one shared set of weights. A
/// state holds the KV caches and the encoder/decoder compute buffers, roughly
/// 0.3 GB for small and 0.5–1 GB for the large-v3 class (Breeze, a large-v2
/// fine-tune with the full 32-layer decoder, sits at the top of that). So
/// resident use is ≈ 0.8 GB for small, ≈ 2–2.5 GB for turbo and ≈ 3–3.5 GB for
/// Breeze — next to the webview (~0.5 GB) and an OS that wants several GB of
/// its own. 4 GiB machines can carry small; the large models need 8 GiB.
///
/// `ram_needed_bytes` is the top of each of those ranges, rounded up to half a
/// GiB so the card reads "about N GB": 1 GiB for small, 2.5 GiB for turbo q5_0,
/// 3 GiB for turbo q8_0 (its weights are 0.3 GB larger) and 3.5 GiB for Breeze.
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "whisper-small-q5_1",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        min_ram_bytes: 4 * GIB,
        ram_needed_bytes: GIB,
        load_class: LoadClass::Light,
        heavy: false,
    },
    CatalogEntry {
        id: "whisper-large-v3-turbo-q5_0",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        min_ram_bytes: 8 * GIB,
        ram_needed_bytes: 5 * GIB / 2,
        load_class: LoadClass::Medium,
        heavy: true,
    },
    CatalogEntry {
        id: "whisper-large-v3-turbo-q8_0",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-large-v3-turbo-q8_0.bin",
        bytes: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
        min_ram_bytes: 8 * GIB,
        ram_needed_bytes: 3 * GIB,
        load_class: LoadClass::Medium,
        heavy: true,
    },
    CatalogEntry {
        id: "breeze-asr-25-q5_0",
        family: ModelFamily::Breeze,
        repo: "shdennlin/breeze-asr-25-ggml",
        file: "ggml-breeze-asr-25-q5_0.bin",
        bytes: 1_080_732_091,
        sha256: "f51573bd6ef9b1fac0bd09a1652eda58a1a638d824a08771ccdee1102fe5990a",
        min_ram_bytes: 8 * GIB,
        ram_needed_bytes: 7 * GIB / 2,
        load_class: LoadClass::Heavy,
        heavy: true,
    },
];

/// Look a model up by id.
pub fn entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// The id a session should use: the caller's, or [`DEFAULT_MODEL_ID`].
pub fn resolve_model_id(model: &str) -> &str {
    let model = model.trim();
    if model.is_empty() {
        DEFAULT_MODEL_ID
    } else {
        model
    }
}

/// In [`not_downloaded_error`]; [`failure_code`] keys on it.
const NOT_DOWNLOADED_MARKER: &str = "is not downloaded";
/// In [`not_enough_memory_error`]; [`failure_code`] keys on it.
const MEMORY_MARKER: &str = "not enough memory";

/// The error a session or command returns for a model that is not on disk.
/// Starts with "Local transcription" so the session error classifier treats it
/// as final rather than as a dropped connection to redial.
pub fn not_downloaded_error(id: &str) -> String {
    format!(
        "Local transcription model '{id}' {NOT_DOWNLOADED_MARKER}. Download it in Settings › Transcription."
    )
}

/// The error for a model whisper.cpp could not allocate (see
/// [`init_failure_message`]). Final, like every "Local transcription" error.
pub fn not_enough_memory_error(id: &str) -> String {
    format!(
        "Local transcription: {MEMORY_MARKER} to load model '{id}'. Choose a smaller model in Settings › Transcription."
    )
}

/// The `meeting://error` / `voicetyping://error` code for an on-device failure
/// (a message starting with "Local transcription"): "local-missing" (model not
/// downloaded), "local-memory" (could not be loaded for lack of memory), or
/// "local" for anything else. All three are final — a redial would fail the
/// same way — and each has its own localized message in the frontend.
pub fn failure_code(msg: &str) -> &'static str {
    let low = msg.to_lowercase();
    if low.contains(MEMORY_MARKER) {
        "local-memory"
    } else if low.contains(NOT_DOWNLOADED_MARKER) {
        "local-missing"
    } else {
        "local"
    }
}

/// Whether a model failing to initialize is most likely out of memory: the
/// machine is below the model's RAM floor, or less than twice the model's size
/// is available. whisper.cpp reports an allocation failure as a bare "init
/// failed", the same as any other, so this is a judgement from the hardware —
/// the file itself was size- and checksum-verified when it was installed.
fn memory_suspect(
    entry: &CatalogEntry,
    total_ram: Option<u64>,
    available_ram: Option<u64>,
) -> bool {
    total_ram.is_some_and(|t| !ram_meets(t, entry.min_ram_bytes))
        || available_ram.is_some_and(|a| a < entry.bytes.saturating_mul(2))
}

/// The error for a model whose context (`what` = "failed to load") or decoding
/// state ("could not create a decoding state") could not be created: the
/// memory message when memory is the likely cause, the raw failure otherwise.
pub fn init_failure_message(id: &str, what: &str, err: impl std::fmt::Display) -> String {
    let suspect = entry(id).is_some_and(|e| {
        memory_suspect(
            e,
            crate::hardware::total_ram_bytes(),
            crate::hardware::available_ram_bytes(),
        )
    });
    if suspect {
        not_enough_memory_error(id)
    } else {
        format!("Local transcription model '{id}' {what}: {err}")
    }
}

fn unknown_model_error(id: &str) -> String {
    format!("Local transcription model '{id}' is unknown.")
}

// --- Paths --------------------------------------------------------------------

/// `app_data_dir()/models/stt/`.
pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("models")
        .join("stt"))
}

/// The in-progress download next to the final file: `<file>.part`.
fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Whether `entry` is installed in `dir`: the final file exists with exactly the
/// expected size. The hash was verified before the file got its final name, so
/// it is not re-hashed here (this runs on every Settings render).
fn is_installed_in(dir: &Path, entry: &CatalogEntry) -> bool {
    std::fs::metadata(dir.join(entry.file)).is_ok_and(|m| m.is_file() && m.len() == entry.bytes)
}

/// The on-disk path of an installed model, or the error a session should fail
/// with (unknown id, or not downloaded).
pub fn installed_model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let entry = entry(id).ok_or_else(|| unknown_model_error(id))?;
    let dir = models_dir(app)?;
    if !is_installed_in(&dir, entry) {
        return Err(not_downloaded_error(id));
    }
    Ok(dir.join(entry.file))
}

/// Fail-fast check for the start commands: `Ok` only when the model is ready.
pub fn ensure_installed(app: &AppHandle, model: &str) -> Result<(), String> {
    installed_model_path(app, resolve_model_id(model)).map(|_| ())
}

// --- Hardware fit -------------------------------------------------------------

/// What whisper.cpp decodes on (see [`accel_choice`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Accel {
    Metal,
    Vulkan,
    Cpu,
}

/// Why whisper.cpp runs on the CPU, when it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CpuReason {
    /// This platform has no GPU backend in this build (Intel Macs, Linux).
    UnsupportedPlatform,
    /// No hardware GPU was found (a VM, or only the basic display adapter).
    NoGpu,
    /// A GPU, but no Vulkan 1.2 loader: the GPU driver is missing or too old.
    NoVulkanDriver,
}

/// The acceleration decision and the GPU it was made for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccelChoice {
    pub accel: Accel,
    /// The GPU found, even when it is not used (to name it in the UI).
    pub gpu: Option<crate::hardware::Gpu>,
    /// Set exactly when `accel` is [`Accel::Cpu`].
    pub cpu_reason: Option<CpuReason>,
}

/// ggml's Vulkan backend refuses instances below Vulkan 1.2.
const MIN_VULKAN_API: u32 = crate::hardware::vk_api_version(1, 2);

/// Decide what whisper.cpp decodes on. Pure: the probing is in
/// [`accel_choice`]. Vulkan needs all three of a Vulkan build, a hardware GPU
/// and a loader offering Vulkan 1.2 — the loader is what the delay-loaded
/// `vulkan-1.dll` import needs, so without it the GPU is never asked for.
pub fn choose_accel(
    apple_silicon: bool,
    vulkan_build: bool,
    gpu: Option<crate::hardware::Gpu>,
    loader: crate::hardware::VulkanLoader,
) -> AccelChoice {
    use crate::hardware::VulkanLoader;
    let (accel, cpu_reason) = if apple_silicon {
        (Accel::Metal, None)
    } else if !vulkan_build {
        (Accel::Cpu, Some(CpuReason::UnsupportedPlatform))
    } else if gpu.is_none() {
        (Accel::Cpu, Some(CpuReason::NoGpu))
    } else {
        match loader {
            VulkanLoader::Present { api_version } if api_version >= MIN_VULKAN_API => {
                (Accel::Vulkan, None)
            }
            _ => (Accel::Cpu, Some(CpuReason::NoVulkanDriver)),
        }
    };
    AccelChoice {
        accel,
        gpu,
        cpu_reason,
    }
}

/// This machine's acceleration, probed once per run (DXGI and the Vulkan
/// loader on Windows; the chip name on macOS). Drivers do not change under a
/// running app often enough to re-probe on every Settings render.
pub fn accel_choice() -> &'static AccelChoice {
    static CHOICE: OnceLock<AccelChoice> = OnceLock::new();
    CHOICE.get_or_init(|| {
        let gpu = if APPLE_SILICON {
            Some(crate::hardware::Gpu {
                name: crate::hardware::chip_name()
                    .map(|chip| format!("{chip} GPU"))
                    .unwrap_or_else(|| "Apple GPU".to_string()),
                vram_bytes: None,
                shared: true,
            })
        } else if VULKAN_BUILD {
            crate::hardware::best_gpu(&crate::hardware::gpu_adapters())
        } else {
            None
        };
        let loader = if VULKAN_BUILD && !APPLE_SILICON && gpu.is_some() {
            crate::hardware::vulkan_loader()
        } else {
            crate::hardware::VulkanLoader::Missing
        };
        let choice = choose_accel(APPLE_SILICON, VULKAN_BUILD, gpu, loader);
        log::info!(
            "local-stt: acceleration {:?} (gpu {:?}, loader {loader:?}, cpu reason {:?})",
            choice.accel,
            choice.gpu,
            choice.cpu_reason
        );
        choice
    })
}

/// The acceleration a model load asks for (see [`accel_choice`]).
pub fn accel() -> Accel {
    accel_choice().accel
}

/// Whether live sessions decode interim tails: only where decoding is fast (a
/// GPU). On CPU a re-decode can take longer than the utterance and would hold
/// up the final text behind it. The runtime real-time-factor check
/// (`transcription::local::RtfTracker`) stays the backstop when a GPU is
/// slower than hoped.
pub fn interim_tails(accel: Accel) -> bool {
    accel != Accel::Cpu
}

/// The machine, as `local_stt_hardware` reports it and [`model_fit`] judges it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttHardware {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    /// Free space on the volume that holds the models directory.
    pub free_disk_bytes: u64,
    pub accel: Accel,
    /// Why `accel` is cpu; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_reason: Option<CpuReason>,
    /// The GPU found (also when it is not used, e.g. without a Vulkan driver).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name: Option<String>,
    /// Its dedicated video memory; absent when unknown (Apple Silicon).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_vram_bytes: Option<u64>,
    /// It shares system RAM (an integrated GPU, Apple's unified memory).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_shared: Option<bool>,
    /// Physical cores (logical when the OS will not say).
    pub cpu_cores: u32,
    /// `std::env::consts::OS`: "macos", "windows", "linux".
    pub os: &'static str,
    /// `std::env::consts::ARCH`: "aarch64", "x86_64".
    pub arch: &'static str,
}

/// How well a model suits this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FitLevel {
    Good,
    Slow,
    Unsupported,
}

/// Why a model is not a [`FitLevel::Good`] fit, most severe first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FitReason {
    /// Not enough free disk to download it: the one hard block.
    DiskLow,
    /// Total RAM is below the model's floor: the UI asks for confirmation.
    RamLow,
    /// Little memory is free right now (other apps); may stutter.
    RamTight,
    /// Vulkan on a discrete GPU with less video memory than the model needs
    /// ([`vram_needed_bytes`]): it may spill to system memory or fall back to
    /// the CPU.
    VramLow,
    /// A large model with no GPU acceleration and a modest CPU.
    CpuOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Fit {
    pub level: FitLevel,
    pub reasons: Vec<FitReason>,
}

/// Free disk a download needs beyond the model itself: the `.part` file is the
/// full model, and a volume filled to the last byte breaks everything else.
pub const DISK_HEADROOM_BYTES: u64 = 512 * MIB;
/// A CPU this strong runs a heavy model acceptably without a GPU: 8 physical
/// cores (whisper.cpp uses up to 8 threads, see [`thread_count`]) and 16 GB.
const STRONG_CPU_CORES: u32 = 8;
const STRONG_CPU_RAM_BYTES: u64 = 16 * GIB;

/// Whether `total` RAM counts as at least `nominal`. RAM is sold in nominal
/// sizes, but the OS reports less once firmware and an integrated GPU have
/// taken their share (an "8 GB" Windows laptop often reports ~7.7 GiB), so a
/// 1/16 shortfall still counts as the nominal size.
fn ram_meets(total: u64, nominal: u64) -> bool {
    total >= nominal - nominal / 16
}

/// Free disk a model's download needs.
pub fn disk_needed_bytes(entry: &CatalogEntry) -> u64 {
    entry.bytes + DISK_HEADROOM_BYTES
}

/// Video memory beyond the weights a model needs on a discrete GPU: the
/// decoding states of a meeting's two sessions (KV caches and compute buffers,
/// a few hundred MB each for the large-v3 class; see [`CATALOG`]).
pub const VRAM_HEADROOM_BYTES: u64 = GIB;

/// Video memory a model needs on a discrete GPU to run there comfortably.
pub fn vram_needed_bytes(entry: &CatalogEntry) -> u64 {
    entry.bytes + VRAM_HEADROOM_BYTES
}

/// Judge `entry` against `hw`. Pure: the probing happens elsewhere.
///
/// - `disk_low` (not installed, free < size + [`DISK_HEADROOM_BYTES`]) and
///   `ram_low` (total RAM under `min_ram_bytes`) make it `unsupported`.
/// - `ram_tight` (available < 2 × size; skipped when the weights are already
///   `resident`), `vram_low` (a `heavy` model on Vulkan with a discrete GPU
///   whose dedicated memory is under [`vram_needed_bytes`]) and `cpu_only` (a
///   `heavy` model without GPU acceleration on a CPU short of
///   [`STRONG_CPU_CORES`] cores / [`STRONG_CPU_RAM_BYTES`]) make it `slow`.
///   A GPU that shares system RAM has no VRAM rule of its own: the RAM rules
///   above are its memory rules.
/// - Otherwise `good`.
pub fn model_fit(
    entry: &CatalogEntry,
    hw: &LocalSttHardware,
    installed: bool,
    resident: bool,
) -> Fit {
    let mut reasons = Vec::new();
    if !installed && hw.free_disk_bytes < disk_needed_bytes(entry) {
        reasons.push(FitReason::DiskLow);
    }
    if !ram_meets(hw.total_ram_bytes, entry.min_ram_bytes) {
        reasons.push(FitReason::RamLow);
    }
    if !resident && hw.available_ram_bytes < entry.bytes.saturating_mul(2) {
        reasons.push(FitReason::RamTight);
    }
    if entry.heavy && hw.accel == Accel::Vulkan && hw.gpu_shared == Some(false) {
        if let Some(vram) = hw.gpu_vram_bytes {
            if vram < vram_needed_bytes(entry) {
                reasons.push(FitReason::VramLow);
            }
        }
    }
    let strong_cpu =
        hw.cpu_cores >= STRONG_CPU_CORES && ram_meets(hw.total_ram_bytes, STRONG_CPU_RAM_BYTES);
    if entry.heavy && hw.accel == Accel::Cpu && !strong_cpu {
        reasons.push(FitReason::CpuOnly);
    }
    let level = if reasons
        .iter()
        .any(|r| matches!(r, FitReason::DiskLow | FitReason::RamLow))
    {
        FitLevel::Unsupported
    } else if reasons.is_empty() {
        FitLevel::Good
    } else {
        FitLevel::Slow
    };
    Fit { level, reasons }
}

/// The model to suggest for this machine: the default when it is a good fit,
/// else the largest good whisper-family model, else none. Breeze is never
/// picked here — whether its Taiwanese-Mandarin strength matters depends on
/// the user, which the frontend knows (it may prefer Breeze for zh-TW).
pub fn recommended_id(fits: &[(&'static CatalogEntry, Fit)]) -> Option<&'static str> {
    let good = || {
        fits.iter()
            .filter(|(e, f)| e.family == ModelFamily::Whisper && f.level == FitLevel::Good)
    };
    if good().any(|(e, _)| e.id == DEFAULT_MODEL_ID) {
        return Some(DEFAULT_MODEL_ID);
    }
    good().max_by_key(|(e, _)| e.bytes).map(|(e, _)| e.id)
}

/// Read this machine. `dir` is the models directory: it is created first so its
/// own volume is measured (a missing directory falls back to its nearest
/// existing ancestor). Fails only when total RAM or free disk is unreadable;
/// unreadable available memory counts as all of it (no `ram_tight`).
fn probe_hardware(dir: &Path) -> Result<LocalSttHardware, String> {
    let _ = std::fs::create_dir_all(dir);
    let total_ram_bytes = crate::hardware::total_ram_bytes()
        .ok_or_else(|| "could not read the installed memory".to_string())?;
    let available_ram_bytes = crate::hardware::available_ram_bytes()
        .unwrap_or(total_ram_bytes)
        .min(total_ram_bytes);
    let free_disk_bytes = crate::hardware::free_disk_bytes(dir)
        .ok_or_else(|| "could not read the free disk space".to_string())?;
    let choice = accel_choice();
    Ok(LocalSttHardware {
        total_ram_bytes,
        available_ram_bytes,
        free_disk_bytes,
        accel: choice.accel,
        cpu_reason: choice.cpu_reason,
        gpu_name: choice.gpu.as_ref().map(|g| g.name.clone()),
        gpu_vram_bytes: choice.gpu.as_ref().and_then(|g| g.vram_bytes),
        gpu_shared: choice.gpu.as_ref().map(|g| g.shared),
        cpu_cores: crate::hardware::physical_cores(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })
}

/// The download refusal for a volume without room for `entry` (free space
/// unknown = allowed: the write itself would fail cleanly).
fn check_disk(entry: &CatalogEntry, free: Option<u64>) -> Result<(), String> {
    match free {
        Some(free) if free < disk_needed_bytes(entry) => Err(format!(
            "Not enough free disk space for '{}': it needs {} MB free (the model plus {} MB headroom) and only {} MB are available.",
            entry.id,
            disk_needed_bytes(entry).div_ceil(1_000_000),
            DISK_HEADROOM_BYTES / 1_000_000,
            free / 1_000_000
        )),
        _ => Ok(()),
    }
}

// --- Loaded-model cache and leases --------------------------------------------

/// The one loaded model, keyed by id, with what it actually runs on. Loading a
/// different model replaces it, so at most one model's weights are resident
/// (the old one is freed once the last session holding its `Arc` ends).
type LoadedSlot = Mutex<Option<(String, Arc<WhisperContext>, Accel)>>;

fn loaded() -> &'static LoadedSlot {
    static LOADED: OnceLock<LoadedSlot> = OnceLock::new();
    LOADED.get_or_init(|| Mutex::new(None))
}

/// Serializes model loads, so the mic and system-audio sessions of one meeting
/// starting together load the model once rather than twice.
fn load_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// How many sessions currently use each model id.
fn leases() -> &'static Mutex<HashMap<String, usize>> {
    static LEASES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Marks a model as in use for as long as it lives; [`local_stt_delete`]
/// refuses to delete a leased model.
pub struct ModelLease {
    id: String,
}

impl ModelLease {
    pub fn new(id: &str) -> Self {
        *leases().lock().unwrap().entry(id.to_string()).or_insert(0) += 1;
        Self { id: id.to_string() }
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        let mut leases = leases().lock().unwrap();
        if let Some(n) = leases.get_mut(&self.id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                leases.remove(&self.id);
            }
        }
    }
}

fn is_leased(id: &str) -> bool {
    leases().lock().unwrap().get(id).is_some_and(|n| *n > 0)
}

/// Threads whisper.cpp uses for its CPU work.
pub fn thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8) as i32
}

/// `local-stt://slow` payload.
#[derive(Clone, Debug, Serialize)]
struct SlowPayload<'a> {
    model: &'a str,
    rtf: f32,
}

/// Tell the UI that decoding `model` is not keeping up with real time (median
/// real-time factor `rtf`). Called at most once per session.
pub fn emit_slow(app: &AppHandle, model: &str, rtf: f32) {
    log::warn!("local-stt: {model} is decoding slower than real time (median RTF {rtf:.2})");
    let _ = app.emit(SLOW_EVENT, SlowPayload { model, rtf });
}

/// whisper.cpp context parameters for `accel`. Flash attention goes with the
/// GPU, as whisper.cpp's own defaults have it (both Metal and Vulkan implement
/// it; an op a device cannot run is scheduled on the CPU by ggml).
pub fn context_params(accel: Accel) -> WhisperContextParameters<'static> {
    let gpu = accel != Accel::Cpu;
    let mut params = WhisperContextParameters::default();
    params.use_gpu(gpu);
    params.flash_attn(gpu);
    params
}

/// Load a context on `accel`, and once more on the CPU if the GPU load fails
/// (a driver that rejects the model, video memory that runs out): a model the
/// CPU can run must not fail just because the GPU could not. Returns the
/// context and what it ended up on.
fn new_context(
    id: &str,
    path: &str,
    accel: Accel,
) -> Result<(WhisperContext, Accel), whisper_rs::WhisperError> {
    match WhisperContext::new_with_params(path, context_params(accel)) {
        Ok(ctx) => Ok((ctx, accel)),
        Err(e) if accel != Accel::Cpu => {
            log::warn!(
                "local-stt: {id} failed to load on the GPU ({accel:?}): {e}; retrying on the CPU"
            );
            WhisperContext::new_with_params(path, context_params(Accel::Cpu))
                .map(|ctx| (ctx, Accel::Cpu))
        }
        Err(e) => Err(e),
    }
}

/// The shared context for model `id`, loading it on first use, and the
/// acceleration it runs on. Blocking (a large model takes seconds to load):
/// call it from `spawn_blocking`.
pub fn load_context(app: &AppHandle, id: &str) -> Result<(Arc<WhisperContext>, Accel), String> {
    let _serial = load_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((loaded_id, ctx, accel)) = loaded().lock().unwrap().as_ref() {
        if loaded_id == id {
            return Ok((ctx.clone(), *accel));
        }
    }
    let path = installed_model_path(app, id)?;
    // Drop the previous model before loading the next one, so two large models
    // are never resident at once on behalf of the cache.
    *loaded().lock().unwrap() = None;

    whisper_rs::install_logging_hooks();
    let started = Instant::now();
    let path_str = path
        .to_str()
        .ok_or_else(|| "Local transcription model path is not valid UTF-8".to_string())?;
    let (ctx, accel) = new_context(id, path_str, accel()).map_err(|e| {
        log::warn!("local-stt: {id} failed to load: {e}");
        init_failure_message(id, "failed to load", e)
    })?;
    log::info!(
        "local-stt: loaded {id} on {accel:?} in {}ms",
        started.elapsed().as_millis()
    );
    let ctx = Arc::new(ctx);
    *loaded().lock().unwrap() = Some((id.to_string(), ctx.clone(), accel));
    Ok((ctx, accel))
}

/// Whether model `id`'s weights are loaded right now (they no longer count
/// against available memory).
fn is_resident(id: &str) -> bool {
    loaded()
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(loaded_id, _, _)| loaded_id == id)
}

/// Drop the cached context if it is model `id` (sessions still holding it keep
/// their `Arc` until they end).
fn unload(id: &str) {
    let mut slot = loaded().lock().unwrap();
    if slot
        .as_ref()
        .is_some_and(|(loaded_id, _, _)| loaded_id == id)
    {
        *slot = None;
    }
}

// --- Downloads ------------------------------------------------------------------

/// Cancel flags of the downloads in flight, by model id. Presence = in flight.
fn downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static DOWNLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_downloading(id: &str) -> bool {
    downloads().lock().unwrap().contains_key(id)
}

/// Removes a download's registry entry however its task ends.
struct DownloadSlot {
    id: String,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        downloads().lock().unwrap().remove(&self.id);
    }
}

/// Stage of a download, as sent in [`Progress::stage`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Downloading,
    Verifying,
    Done,
    Error,
    Cancelled,
}

/// `local-stt://progress` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    model_id: String,
    stage: Stage,
    received: u64,
    total: u64,
    message: Option<String>,
}

/// Rate-limits progress events: one per [`Throttle::INTERVAL`] or per percent of
/// progress, whichever comes first — a gigabyte arrives in tens of thousands of
/// chunks, and an event per chunk would flood the webview.
struct Throttle {
    last_at: Option<Instant>,
    last_received: u64,
}

impl Throttle {
    const INTERVAL: Duration = Duration::from_millis(100);

    fn new() -> Self {
        Self {
            last_at: None,
            last_received: 0,
        }
    }

    fn should_emit(&mut self, now: Instant, received: u64, total: u64) -> bool {
        let step = (total / 100).max(1);
        let due = match self.last_at {
            None => true,
            Some(at) => {
                now.duration_since(at) >= Self::INTERVAL
                    || received.saturating_sub(self.last_received) >= step
            }
        };
        if due {
            self.last_at = Some(now);
            self.last_received = received;
        }
        due
    }
}

/// Why a download did not produce a verified file.
#[derive(Debug, PartialEq, Eq)]
enum DownloadError {
    Cancelled,
    Failed(String),
}

/// Stream `url` into `dest` via `<dest>.part`: hash while writing, check the
/// byte count and SHA-256, then rename into place. The `.part` file is removed
/// on every failure and on cancel, so a half-written model never sits under its
/// final name. `progress(stage, received)` reports the downloading and
/// verifying stages.
async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Stage, u64),
) -> Result<(), DownloadError> {
    use futures_util::StreamExt;

    let part = part_path(dest);
    let fail = |part: &Path, e: DownloadError| {
        let _ = std::fs::remove_file(part);
        Err(e)
    };
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return Err(DownloadError::Failed(format!("request failed: {e}"))),
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => return Err(DownloadError::Failed(format!("download failed: {e}"))),
    };
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| DownloadError::Failed(format!("create models dir: {e}")))?;
    }
    let mut file = match std::fs::File::create(&part) {
        Ok(f) => std::io::BufWriter::with_capacity(1 << 20, f),
        Err(e) => return Err(DownloadError::Failed(format!("create temp file: {e}"))),
    };
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    progress(Stage::Downloading, 0);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            return fail(&part, DownloadError::Cancelled);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                return fail(
                    &part,
                    DownloadError::Failed(format!("download interrupted: {e}")),
                );
            }
        };
        received += chunk.len() as u64;
        if received > expected_bytes {
            drop(file);
            return fail(
                &part,
                DownloadError::Failed(format!(
                    "download is larger than expected ({expected_bytes} bytes)"
                )),
            );
        }
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            return fail(&part, DownloadError::Failed(format!("write failed: {e}")));
        }
        hasher.update(&chunk);
        progress(Stage::Downloading, received);
    }
    if cancel.load(Ordering::SeqCst) {
        drop(file);
        return fail(&part, DownloadError::Cancelled);
    }
    progress(Stage::Verifying, received);
    let flushed = file
        .into_inner()
        .map_err(|e| e.into_error())
        .and_then(|f| f.sync_all());
    if let Err(e) = flushed {
        return fail(&part, DownloadError::Failed(format!("write failed: {e}")));
    }
    if received != expected_bytes {
        return fail(
            &part,
            DownloadError::Failed(format!(
                "download ended early ({received} of {expected_bytes} bytes)"
            )),
        );
    }
    let got = to_hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(expected_sha256) {
        return fail(
            &part,
            DownloadError::Failed(format!(
                "checksum mismatch (expected {expected_sha256}, got {got})"
            )),
        );
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        DownloadError::Failed(format!("finalize model file: {e}"))
    })
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// --- Commands -----------------------------------------------------------------

/// A catalog entry as the Settings UI sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttModel {
    id: &'static str,
    family: ModelFamily,
    size_bytes: u64,
    /// The verified file is on disk (exact size; see [`is_installed_in`]).
    installed: bool,
    downloading: bool,
    /// The model's RAM floor (see [`CatalogEntry::min_ram_bytes`]).
    min_ram_bytes: u64,
    /// Free disk its download needs ([`disk_needed_bytes`]).
    disk_needed_bytes: u64,
    /// Typical resident memory while running ([`CatalogEntry::ram_needed_bytes`]).
    ram_needed_bytes: u64,
    /// Video memory it wants on a discrete GPU ([`vram_needed_bytes`]).
    vram_needed_bytes: u64,
    load_class: LoadClass,
    heavy: bool,
    /// How well it suits this machine; `null` when the hardware could not be
    /// read (the UI then shows no fit at all and blocks nothing).
    fit: Option<Fit>,
}

/// The catalog judged against `hw` (fits are `None` without it).
fn catalog_fits(
    dir: &Path,
    hw: Option<&LocalSttHardware>,
) -> Vec<(&'static CatalogEntry, bool, Option<Fit>)> {
    CATALOG
        .iter()
        .map(|e| {
            let installed = is_installed_in(dir, e);
            let fit = hw.map(|hw| model_fit(e, hw, installed, is_resident(e.id)));
            (e, installed, fit)
        })
        .collect()
}

#[tauri::command]
pub fn local_stt_models(app: AppHandle) -> Result<Vec<LocalSttModel>, String> {
    let dir = models_dir(&app)?;
    let hw = probe_hardware(&dir)
        .inspect_err(|e| log::warn!("local-stt: hardware probe failed: {e}"))
        .ok();
    Ok(catalog_fits(&dir, hw.as_ref())
        .into_iter()
        .map(|(e, installed, fit)| LocalSttModel {
            id: e.id,
            family: e.family,
            size_bytes: e.bytes,
            installed,
            downloading: is_downloading(e.id),
            min_ram_bytes: e.min_ram_bytes,
            disk_needed_bytes: disk_needed_bytes(e),
            ram_needed_bytes: e.ram_needed_bytes,
            vram_needed_bytes: vram_needed_bytes(e),
            load_class: e.load_class,
            heavy: e.heavy,
            fit,
        })
        .collect())
}

/// `local_stt_hardware` result: the machine plus the model to suggest for it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttHardwareReport {
    #[serde(flatten)]
    hardware: LocalSttHardware,
    /// See [`recommended_id`]; `null` when no whisper model is a good fit.
    recommended_id: Option<&'static str>,
}

/// This machine's memory, free disk (on the models volume), acceleration (and
/// the GPU, or why there is none), cores, and the recommended model. Cheap (a few OS calls), so the UI simply
/// calls it again whenever the numbers may have moved.
#[tauri::command]
pub fn local_stt_hardware(app: AppHandle) -> Result<LocalSttHardwareReport, String> {
    let dir = models_dir(&app)?;
    let hardware = probe_hardware(&dir)?;
    let fits: Vec<(&'static CatalogEntry, Fit)> = catalog_fits(&dir, Some(&hardware))
        .into_iter()
        .filter_map(|(e, _, fit)| fit.map(|f| (e, f)))
        .collect();
    Ok(LocalSttHardwareReport {
        recommended_id: recommended_id(&fits),
        hardware,
    })
}

/// Download, verify and install a model. Resolves once the verified file is in
/// place (immediately when it already is). Emits `local-stt://progress`
/// throughout; a cancel ([`local_stt_cancel`]) ends it with stage `cancelled`
/// and an `Err("cancelled")`.
#[tauri::command]
pub async fn local_stt_download(app: AppHandle, model_id: String) -> Result<(), String> {
    let entry = entry(&model_id).ok_or_else(|| unknown_model_error(&model_id))?;
    let dir = models_dir(&app)?;
    let emit = |stage: Stage, received: u64, message: Option<String>| {
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress {
                model_id: entry.id.to_string(),
                stage,
                received,
                total: entry.bytes,
                message,
            },
        );
    };
    if is_installed_in(&dir, entry) {
        emit(Stage::Done, entry.bytes, None);
        return Ok(());
    }
    // The UI disables Download on a full disk, but its numbers can be stale
    // (another app filled the volume since): check again here.
    let _ = std::fs::create_dir_all(&dir);
    if let Err(msg) = check_disk(entry, crate::hardware::free_disk_bytes(&dir)) {
        log::warn!("local-stt: {} download refused: {msg}", entry.id);
        emit(Stage::Error, 0, Some(msg.clone()));
        return Err(msg);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut inflight = downloads().lock().unwrap();
        if inflight.contains_key(entry.id) {
            return Err(format!(
                "Local transcription model '{}' is already downloading.",
                entry.id
            ));
        }
        inflight.insert(entry.id.to_string(), cancel.clone());
    }
    let _slot = DownloadSlot {
        id: entry.id.to_string(),
    };

    log::info!(
        "local-stt: downloading {} ({} bytes)",
        entry.id,
        entry.bytes
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // A stalled transfer fails instead of hanging the progress bar forever.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut throttle = Throttle::new();
    let result = download_verified(
        &client,
        &entry.url(),
        &dir.join(entry.file),
        entry.bytes,
        entry.sha256,
        &cancel,
        |stage, received| {
            if stage != Stage::Downloading
                || throttle.should_emit(Instant::now(), received, entry.bytes)
            {
                emit(stage, received, None);
            }
        },
    )
    .await;
    // Out of the registry before the terminal event: the UI re-reads
    // `local_stt_models` on it and must see `downloading: false`.
    drop(_slot);
    match result {
        Ok(()) => {
            log::info!("local-stt: {} installed", entry.id);
            emit(Stage::Done, entry.bytes, None);
            Ok(())
        }
        Err(DownloadError::Cancelled) => {
            log::info!("local-stt: {} download cancelled", entry.id);
            emit(Stage::Cancelled, 0, None);
            Err("cancelled".to_string())
        }
        Err(DownloadError::Failed(msg)) => {
            log::warn!("local-stt: {} download failed: {msg}", entry.id);
            emit(Stage::Error, 0, Some(msg.clone()));
            Err(format!("Downloading '{}' failed: {msg}", entry.id))
        }
    }
}

/// Cancel an in-flight download (no-op when none). The download task deletes
/// its `.part` file and emits stage `cancelled`.
#[tauri::command]
pub fn local_stt_cancel(model_id: String) {
    if let Some(flag) = downloads().lock().unwrap().get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Delete an installed model (and any leftover `.part`). Refused while a
/// session is using the model; an in-flight download of it is cancelled.
#[tauri::command]
pub fn local_stt_delete(app: AppHandle, model_id: String) -> Result<(), String> {
    let entry = entry(&model_id).ok_or_else(|| unknown_model_error(&model_id))?;
    if is_leased(entry.id) {
        return Err(format!(
            "Local transcription model '{}' is in use. Stop the meeting or dictation first.",
            entry.id
        ));
    }
    local_stt_cancel(entry.id.to_string());
    unload(entry.id);
    let path = models_dir(&app)?.join(entry.file);
    let _ = std::fs::remove_file(part_path(&path));
    match std::fs::remove_file(&path) {
        Ok(()) => {
            log::info!("local-stt: deleted {}", entry.id);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Deleting '{}' failed: {e}", entry.id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.file, b.file, "two entries would share one file");
            }
        }
    }

    #[test]
    fn catalog_entries_are_well_formed() {
        for e in CATALOG {
            assert_eq!(e.sha256.len(), 64, "{}", e.id);
            assert!(
                e.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{} sha256 must be lowercase hex",
                e.id
            );
            assert!(e.url().starts_with("https://huggingface.co/"), "{}", e.id);
            assert!(e.url().ends_with(e.file));
            assert!(e.file.ends_with(".bin"));
            assert!(e.bytes > 1_000_000);
        }
    }

    #[test]
    fn the_default_model_is_in_the_catalog() {
        assert!(entry(DEFAULT_MODEL_ID).is_some());
        assert_eq!(resolve_model_id(""), DEFAULT_MODEL_ID);
        assert_eq!(resolve_model_id("  "), DEFAULT_MODEL_ID);
        assert_eq!(resolve_model_id("breeze-asr-25-q5_0"), "breeze-asr-25-q5_0");
    }

    #[test]
    fn breeze_is_its_own_family() {
        assert_eq!(
            entry("breeze-asr-25-q5_0").unwrap().family,
            ModelFamily::Breeze
        );
        assert_eq!(
            serde_json::to_value(ModelFamily::Breeze).unwrap(),
            serde_json::json!("breeze")
        );
    }

    #[test]
    fn the_part_file_sits_next_to_the_model() {
        let p = part_path(Path::new("/x/models/stt/ggml-small-q5_1.bin"));
        assert_eq!(p, PathBuf::from("/x/models/stt/ggml-small-q5_1.bin.part"));
    }

    #[test]
    fn the_not_downloaded_error_classifies_as_local() {
        let msg = not_downloaded_error("whisper-small-q5_1");
        assert!(msg.starts_with("Local transcription"));
        assert!(msg.contains("whisper-small-q5_1"));
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("parley-local-stt-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_an_exact_size_file_counts_as_installed() {
        let dir = scratch_dir("installed");
        let e = CatalogEntry {
            id: "t",
            family: ModelFamily::Whisper,
            repo: "r/r",
            file: "m.bin",
            bytes: 4,
            sha256: "",
            min_ram_bytes: 0,
            ram_needed_bytes: 0,
            load_class: LoadClass::Light,
            heavy: false,
        };
        assert!(!is_installed_in(&dir, &e));
        // A leftover .part never reads as installed.
        std::fs::write(part_path(&dir.join("m.bin")), b"abcd").unwrap();
        assert!(!is_installed_in(&dir, &e));
        std::fs::write(dir.join("m.bin"), b"abc").unwrap();
        assert!(!is_installed_in(&dir, &e));
        std::fs::write(dir.join("m.bin"), b"abcd").unwrap();
        assert!(is_installed_in(&dir, &e));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Hardware fit -----------------------------------------------------------

    fn hw(
        total_gib: u64,
        available_gib: u64,
        free_disk_gib: u64,
        accel: Accel,
        cores: u32,
    ) -> LocalSttHardware {
        LocalSttHardware {
            total_ram_bytes: total_gib * GIB,
            available_ram_bytes: available_gib * GIB,
            free_disk_bytes: free_disk_gib * GIB,
            accel,
            cpu_reason: (accel == Accel::Cpu).then_some(CpuReason::UnsupportedPlatform),
            gpu_name: None,
            gpu_vram_bytes: None,
            gpu_shared: None,
            cpu_cores: cores,
            os: "test",
            arch: "test",
        }
    }

    /// A Windows PC decoding on Vulkan with `vram_gib` of dedicated memory
    /// (`shared` for an integrated GPU).
    fn vulkan_pc(total_gib: u64, cores: u32, vram_mib: u64, shared: bool) -> LocalSttHardware {
        LocalSttHardware {
            gpu_name: Some("Test GPU".into()),
            gpu_vram_bytes: Some(vram_mib * MIB),
            gpu_shared: Some(shared),
            ..hw(total_gib, total_gib / 2, 100, Accel::Vulkan, cores)
        }
    }

    fn turbo_q8() -> &'static CatalogEntry {
        entry("whisper-large-v3-turbo-q8_0").unwrap()
    }

    fn small() -> &'static CatalogEntry {
        entry("whisper-small-q5_1").unwrap()
    }
    fn turbo() -> &'static CatalogEntry {
        entry("whisper-large-v3-turbo-q5_0").unwrap()
    }
    fn breeze() -> &'static CatalogEntry {
        entry("breeze-asr-25-q5_0").unwrap()
    }

    fn fit(level: FitLevel, reasons: &[FitReason]) -> Fit {
        Fit {
            level,
            reasons: reasons.to_vec(),
        }
    }

    #[test]
    fn catalog_requirements_follow_the_model_class() {
        assert_eq!(small().min_ram_bytes, 4 * GIB);
        assert!(!small().heavy);
        for e in CATALOG.iter().filter(|e| e.id != small().id) {
            assert_eq!(e.min_ram_bytes, 8 * GIB, "{}", e.id);
            assert!(e.heavy, "{}", e.id);
        }
    }

    #[test]
    fn every_model_carries_a_load_hint_inside_its_ram_floor() {
        assert_eq!(small().load_class, LoadClass::Light);
        assert_eq!(turbo().load_class, LoadClass::Medium);
        assert_eq!(turbo_q8().load_class, LoadClass::Medium);
        assert_eq!(breeze().load_class, LoadClass::Heavy);
        for e in CATALOG {
            // More than the weights, well under the RAM floor (the OS and the
            // webview need the rest), and a round half-GiB for "about N GB".
            assert!(e.ram_needed_bytes > e.bytes, "{}", e.id);
            assert!(e.ram_needed_bytes < e.min_ram_bytes, "{}", e.id);
            assert_eq!(e.ram_needed_bytes % (GIB / 2), 0, "{}", e.id);
        }
        // Heavier class, more memory.
        let mut by_need: Vec<_> = CATALOG.iter().collect();
        by_need.sort_by_key(|e| e.ram_needed_bytes);
        let classes: Vec<_> = by_need.iter().map(|e| e.load_class).collect();
        assert_eq!(
            classes,
            [
                LoadClass::Light,
                LoadClass::Medium,
                LoadClass::Medium,
                LoadClass::Heavy
            ]
        );
    }

    // --- Acceleration -------------------------------------------------------------

    fn gpu(shared: bool) -> Option<crate::hardware::Gpu> {
        Some(crate::hardware::Gpu {
            name: "Test GPU".into(),
            vram_bytes: Some(if shared { 128 * MIB } else { 8 * GIB }),
            shared,
        })
    }

    #[test]
    fn vulkan_needs_a_vulkan_build_a_gpu_and_a_vulkan_1_2_loader() {
        use crate::hardware::{vk_api_version, VulkanLoader};
        let v13 = VulkanLoader::Present {
            api_version: vk_api_version(1, 3),
        };
        let pick = |vulkan_build, gpu, loader| {
            let c = choose_accel(false, vulkan_build, gpu, loader);
            (c.accel, c.cpu_reason)
        };
        assert_eq!(pick(true, gpu(false), v13), (Accel::Vulkan, None));
        // An iGPU with a driver runs Vulkan too.
        assert_eq!(pick(true, gpu(true), v13), (Accel::Vulkan, None));
        // Exactly 1.2 is enough; 1.1 is not (ggml refuses it).
        assert_eq!(
            pick(
                true,
                gpu(false),
                VulkanLoader::Present {
                    api_version: vk_api_version(1, 2)
                }
            ),
            (Accel::Vulkan, None)
        );
        assert_eq!(
            pick(
                true,
                gpu(false),
                VulkanLoader::Present {
                    api_version: vk_api_version(1, 1) + 203
                }
            ),
            (Accel::Cpu, Some(CpuReason::NoVulkanDriver))
        );
        // A GPU but no loader: CPU, and the UI can say why.
        assert_eq!(
            pick(true, gpu(false), VulkanLoader::Missing),
            (Accel::Cpu, Some(CpuReason::NoVulkanDriver))
        );
        // No hardware GPU (a VM): CPU even with a loader installed.
        assert_eq!(pick(true, None, v13), (Accel::Cpu, Some(CpuReason::NoGpu)));
        // No Vulkan in this build (Intel Mac, Linux).
        assert_eq!(
            pick(false, gpu(false), v13),
            (Accel::Cpu, Some(CpuReason::UnsupportedPlatform))
        );
        // Apple Silicon is Metal whatever else is passed.
        let mac = choose_accel(true, false, gpu(true), VulkanLoader::Missing);
        assert_eq!((mac.accel, mac.cpu_reason), (Accel::Metal, None));
        // The GPU is reported even when it is not used.
        let no_driver = choose_accel(false, true, gpu(false), VulkanLoader::Missing);
        assert_eq!(no_driver.gpu.map(|g| g.name), Some("Test GPU".to_string()));
    }

    #[test]
    fn interim_tails_and_gpu_parameters_follow_the_accel() {
        assert!(interim_tails(Accel::Metal));
        assert!(interim_tails(Accel::Vulkan));
        assert!(!interim_tails(Accel::Cpu));
        for (accel, gpu) in [
            (Accel::Metal, true),
            (Accel::Vulkan, true),
            (Accel::Cpu, false),
        ] {
            let p = context_params(accel);
            assert_eq!((p.use_gpu, p.flash_attn), (gpu, gpu), "{accel:?}");
        }
    }

    #[test]
    fn a_discrete_gpu_with_enough_vram_runs_everything_well() {
        // 8 GiB card, modest 4-core CPU: the CPU rule does not apply on Vulkan.
        let pc = vulkan_pc(16, 4, 8 << 10, false);
        for e in CATALOG {
            assert_eq!(
                model_fit(e, &pc, false, false),
                fit(FitLevel::Good, &[]),
                "{}",
                e.id
            );
        }
    }

    #[test]
    fn a_discrete_gpu_short_of_vram_is_slow_for_heavy_models() {
        // 2 GiB card: turbo q5_0 needs 0.57 GB + 1 GiB and fits; Breeze
        // (1.08 GB + 1 GiB) does not.
        let pc = vulkan_pc(16, 4, 2 << 10, false);
        assert_eq!(model_fit(turbo(), &pc, false, false).level, FitLevel::Good);
        assert_eq!(
            model_fit(breeze(), &pc, false, false),
            fit(FitLevel::Slow, &[FitReason::VramLow])
        );
        // Small is not heavy: no VRAM rule, it is fine even on the CPU.
        let tiny = vulkan_pc(16, 4, 1 << 10, false);
        assert_eq!(
            model_fit(small(), &tiny, false, false).level,
            FitLevel::Good
        );
        assert_eq!(
            model_fit(turbo(), &tiny, false, false).reasons,
            vec![FitReason::VramLow]
        );
        // The boundary: exactly size + headroom is enough.
        let mut edge = vulkan_pc(16, 4, 0, false);
        edge.gpu_vram_bytes = Some(vram_needed_bytes(breeze()));
        assert_eq!(
            model_fit(breeze(), &edge, false, false).level,
            FitLevel::Good
        );
        edge.gpu_vram_bytes = Some(vram_needed_bytes(breeze()) - 1);
        assert_eq!(
            model_fit(breeze(), &edge, false, false).level,
            FitLevel::Slow
        );
        // Unknown VRAM: no warning.
        edge.gpu_vram_bytes = None;
        assert_eq!(
            model_fit(breeze(), &edge, false, false).level,
            FitLevel::Good
        );
    }

    #[test]
    fn a_shared_gpu_is_judged_by_the_ram_rules_alone() {
        // Intel iGPU reporting 128 MiB of "dedicated" memory: no VRAM rule.
        let laptop = vulkan_pc(16, 4, 128, true);
        for e in CATALOG {
            assert_eq!(
                model_fit(e, &laptop, false, false).level,
                FitLevel::Good,
                "{}",
                e.id
            );
        }
        // ...but it is system RAM, so the RAM rules still bite.
        let mut small_laptop = vulkan_pc(8, 4, 128, true);
        small_laptop.available_ram_bytes = 2 * GIB;
        assert_eq!(
            model_fit(breeze(), &small_laptop, false, false),
            fit(FitLevel::Slow, &[FitReason::RamTight])
        );
        let four = vulkan_pc(4, 4, 128, true);
        assert_eq!(
            model_fit(turbo(), &four, false, false).reasons,
            vec![FitReason::RamLow]
        );
    }

    #[test]
    fn without_a_vulkan_driver_the_cpu_rules_apply() {
        // The GPU is reported, but accel is cpu: cpu_only, never vram_low.
        let mut pc = vulkan_pc(8, 4, 1 << 10, false);
        pc.accel = Accel::Cpu;
        pc.cpu_reason = Some(CpuReason::NoVulkanDriver);
        assert_eq!(
            model_fit(breeze(), &pc, false, false),
            fit(FitLevel::Slow, &[FitReason::CpuOnly])
        );
    }

    #[test]
    fn an_apple_silicon_mac_runs_everything_well() {
        let mac = hw(16, 8, 100, Accel::Metal, 8);
        for e in CATALOG {
            assert_eq!(
                model_fit(e, &mac, false, false),
                fit(FitLevel::Good, &[]),
                "{}",
                e.id
            );
        }
        // An 8 GB M1 still runs the large models on Metal.
        let m1 = hw(8, 4, 100, Accel::Metal, 8);
        assert_eq!(model_fit(breeze(), &m1, false, false).level, FitLevel::Good);
    }

    #[test]
    fn ram_below_the_floor_is_unsupported_with_slack_for_reserved_memory() {
        // 4 GB machine: small fits, turbo does not.
        let four = hw(4, 2, 100, Accel::Metal, 8);
        assert_eq!(
            model_fit(small(), &four, false, false).level,
            FitLevel::Good
        );
        assert_eq!(
            model_fit(turbo(), &four, false, false),
            fit(FitLevel::Unsupported, &[FitReason::RamLow])
        );
        // An "8 GB" laptop reporting 7.7 GiB (iGPU carve-out) still counts as 8.
        let mut laptop = hw(8, 4, 100, Accel::Metal, 8);
        laptop.total_ram_bytes = 77 * GIB / 10;
        assert_eq!(
            model_fit(turbo(), &laptop, false, false).level,
            FitLevel::Good
        );
        // ...but 7 GiB does not.
        laptop.total_ram_bytes = 7 * GIB;
        assert_eq!(
            model_fit(turbo(), &laptop, false, false).reasons,
            vec![FitReason::RamLow]
        );
        // Exactly the floor is enough.
        let exact = hw(8, 4, 100, Accel::Metal, 8);
        assert_eq!(
            model_fit(turbo(), &exact, false, false).level,
            FitLevel::Good
        );
    }

    #[test]
    fn little_free_memory_is_slow_not_blocked() {
        // Breeze is ~1.08 GB: under 2.16 GB available is tight.
        let mut busy = hw(16, 2, 100, Accel::Metal, 8);
        assert_eq!(
            model_fit(breeze(), &busy, false, false),
            fit(FitLevel::Slow, &[FitReason::RamTight])
        );
        // Small (190 MB) is fine on the same machine.
        assert_eq!(
            model_fit(small(), &busy, false, false).level,
            FitLevel::Good
        );
        // Already loaded: its weights are not part of what must still fit.
        assert_eq!(model_fit(breeze(), &busy, true, true).level, FitLevel::Good);
        busy.available_ram_bytes = 3 * GIB;
        assert_eq!(
            model_fit(breeze(), &busy, false, false).level,
            FitLevel::Good
        );
    }

    #[test]
    fn heavy_models_on_cpu_are_slow_unless_the_cpu_is_strong() {
        let modest = hw(8, 4, 100, Accel::Cpu, 4);
        assert_eq!(
            model_fit(turbo(), &modest, false, false),
            fit(FitLevel::Slow, &[FitReason::CpuOnly])
        );
        assert_eq!(
            model_fit(small(), &modest, false, false).level,
            FitLevel::Good
        );
        // 8 cores and 16 GB: good.
        let strong = hw(16, 8, 100, Accel::Cpu, 8);
        assert_eq!(
            model_fit(turbo(), &strong, false, false).level,
            FitLevel::Good
        );
        assert_eq!(
            model_fit(breeze(), &strong, false, false).level,
            FitLevel::Good
        );
        // Either half missing keeps it slow.
        let many_cores_little_ram = hw(8, 4, 100, Accel::Cpu, 16);
        assert_eq!(
            model_fit(turbo(), &many_cores_little_ram, false, false).level,
            FitLevel::Slow
        );
        let few_cores_much_ram = hw(32, 16, 100, Accel::Cpu, 6);
        assert_eq!(
            model_fit(turbo(), &few_cores_much_ram, false, false).level,
            FitLevel::Slow
        );
        // The same modest machine with Metal (Apple Silicon) is fine.
        let metal = hw(8, 4, 100, Accel::Metal, 4);
        assert_eq!(
            model_fit(turbo(), &metal, false, false).level,
            FitLevel::Good
        );
    }

    #[test]
    fn disk_needs_the_model_plus_headroom_unless_installed() {
        let e = turbo();
        let mut machine = hw(16, 8, 0, Accel::Metal, 8);
        machine.free_disk_bytes = e.bytes + DISK_HEADROOM_BYTES - 1;
        assert_eq!(
            model_fit(e, &machine, false, false),
            fit(FitLevel::Unsupported, &[FitReason::DiskLow])
        );
        machine.free_disk_bytes = e.bytes + DISK_HEADROOM_BYTES;
        assert_eq!(model_fit(e, &machine, false, false).level, FitLevel::Good);
        // An installed model needs no more disk.
        machine.free_disk_bytes = 0;
        assert_eq!(model_fit(e, &machine, true, false).level, FitLevel::Good);
    }

    #[test]
    fn reasons_are_listed_most_severe_first() {
        // On Vulkan with a small card, vram_low sits between ram_tight and
        // where cpu_only would be.
        let mut gpu_poor = vulkan_pc(4, 2, 512, false);
        gpu_poor.available_ram_bytes = GIB;
        gpu_poor.free_disk_bytes = 0;
        assert_eq!(
            model_fit(breeze(), &gpu_poor, false, false).reasons,
            [
                FitReason::DiskLow,
                FitReason::RamLow,
                FitReason::RamTight,
                FitReason::VramLow
            ]
        );
        let poor = hw(4, 1, 0, Accel::Cpu, 2);
        assert_eq!(
            model_fit(breeze(), &poor, false, false),
            fit(
                FitLevel::Unsupported,
                &[
                    FitReason::DiskLow,
                    FitReason::RamLow,
                    FitReason::RamTight,
                    FitReason::CpuOnly
                ]
            )
        );
    }

    #[test]
    fn the_fit_serializes_as_the_frontend_expects() {
        let poor = hw(4, 1, 0, Accel::Cpu, 2);
        assert_eq!(
            serde_json::to_value(model_fit(breeze(), &poor, false, false)).unwrap(),
            serde_json::json!({
                "level": "unsupported",
                "reasons": ["disk_low", "ram_low", "ram_tight", "cpu_only"],
            })
        );
        assert_eq!(
            serde_json::to_value(hw(8, 4, 1, Accel::Metal, 8)).unwrap(),
            serde_json::json!({
                "totalRamBytes": 8 * GIB,
                "availableRamBytes": 4 * GIB,
                "freeDiskBytes": GIB,
                "accel": "metal",
                "cpuCores": 8,
                "os": "test",
                "arch": "test",
            })
        );
        let pc = vulkan_pc(16, 8, 2 << 10, false);
        let json = serde_json::to_value(&pc).unwrap();
        assert_eq!(json["accel"], "vulkan");
        assert_eq!(json["gpuName"], "Test GPU");
        assert_eq!(json["gpuVramBytes"], 2 * GIB);
        assert_eq!(json["gpuShared"], false);
        assert!(json.get("cpuReason").is_none());
        let mut no_driver = pc;
        no_driver.accel = Accel::Cpu;
        no_driver.cpu_reason = Some(CpuReason::NoVulkanDriver);
        assert_eq!(
            serde_json::to_value(&no_driver).unwrap()["cpuReason"],
            "no_vulkan_driver"
        );
        assert_eq!(
            serde_json::to_value([CpuReason::UnsupportedPlatform, CpuReason::NoGpu]).unwrap(),
            serde_json::json!(["unsupported_platform", "no_gpu"])
        );
        assert_eq!(
            serde_json::to_value(fit(FitLevel::Slow, &[FitReason::VramLow])).unwrap()["reasons"],
            serde_json::json!(["vram_low"])
        );
        assert_eq!(
            serde_json::to_value([LoadClass::Light, LoadClass::Medium, LoadClass::Heavy]).unwrap(),
            serde_json::json!(["light", "medium", "heavy"])
        );
    }

    fn fits_for(machine: &LocalSttHardware) -> Vec<(&'static CatalogEntry, Fit)> {
        CATALOG
            .iter()
            .map(|e| (e, model_fit(e, machine, false, false)))
            .collect()
    }

    #[test]
    fn the_recommendation_is_the_default_when_it_fits_else_the_best_good_whisper() {
        assert_eq!(
            recommended_id(&fits_for(&hw(16, 8, 100, Accel::Metal, 8))),
            Some(DEFAULT_MODEL_ID)
        );
        // Modest CPU-only PC: turbo is slow, small is the pick.
        assert_eq!(
            recommended_id(&fits_for(&hw(8, 4, 100, Accel::Cpu, 4))),
            Some("whisper-small-q5_1")
        );
        // Not enough disk for turbo but enough for small.
        assert_eq!(
            recommended_id(&fits_for(&hw(16, 8, 1, Accel::Metal, 8))),
            Some("whisper-small-q5_1")
        );
        // Nothing fits: no recommendation.
        assert_eq!(
            recommended_id(&fits_for(&hw(2, 1, 100, Accel::Cpu, 2))),
            None
        );
        // Breeze is never the backend's pick, even when it is the only good one.
        let only_breeze = vec![
            (breeze(), fit(FitLevel::Good, &[])),
            (turbo(), fit(FitLevel::Slow, &[FitReason::CpuOnly])),
        ];
        assert_eq!(recommended_id(&only_breeze), None);
    }

    #[test]
    fn a_download_is_refused_without_room_for_model_and_headroom() {
        let e = turbo();
        let need = e.bytes + DISK_HEADROOM_BYTES;
        let err = check_disk(e, Some(need - 1)).unwrap_err();
        assert!(err.contains("Not enough free disk space"), "{err}");
        assert!(err.contains(e.id));
        assert_eq!(check_disk(e, Some(need)), Ok(()));
        // Unknown free space does not block.
        assert_eq!(check_disk(e, None), Ok(()));
    }

    #[test]
    fn failure_codes_split_local_errors() {
        assert_eq!(failure_code(&not_downloaded_error("x")), "local-missing");
        assert_eq!(failure_code(&not_enough_memory_error("x")), "local-memory");
        assert_eq!(
            failure_code("Local transcription model 'x' failed to load: init failed"),
            "local"
        );
        assert!(not_enough_memory_error("x").starts_with("Local transcription"));
    }

    #[test]
    fn memory_is_suspected_only_when_the_machine_is_short() {
        let e = turbo();
        assert!(memory_suspect(e, Some(4 * GIB), Some(3 * GIB)));
        assert!(memory_suspect(e, Some(16 * GIB), Some(e.bytes)));
        assert!(!memory_suspect(e, Some(16 * GIB), Some(8 * GIB)));
        assert!(!memory_suspect(e, None, None));
    }

    /// Prints what `local_stt_hardware` reports on the machine running the
    /// tests (`cargo test --lib reports_this_machine -- --nocapture`).
    #[test]
    fn reports_this_machine() {
        let dir = scratch_dir("probe").join("models").join("stt");
        let machine = probe_hardware(&dir).expect("probe");
        let fits = fits_for(&machine);
        println!("{}", serde_json::to_string_pretty(&machine).unwrap());
        for (e, f) in &fits {
            println!("{}: {:?} {:?}", e.id, f.level, f.reasons);
        }
        println!("recommended: {:?}", recommended_id(&fits));
        assert_eq!(machine.accel == Accel::Metal, APPLE_SILICON);
        assert_eq!(machine.accel == Accel::Cpu, machine.cpu_reason.is_some());
        if !VULKAN_BUILD {
            assert_ne!(machine.accel, Accel::Vulkan);
        }
        assert!(machine.total_ram_bytes > 0);
    }

    #[test]
    fn the_throttle_emits_per_interval_or_percent() {
        let mut t = Throttle::new();
        let t0 = Instant::now();
        assert!(t.should_emit(t0, 0, 10_000));
        // Same instant, under 1 %: suppressed.
        assert!(!t.should_emit(t0, 50, 10_000));
        // 1 % of progress: emitted even without time passing.
        assert!(t.should_emit(t0, 100, 10_000));
        // Time passing alone also emits.
        assert!(t.should_emit(t0 + Duration::from_millis(150), 101, 10_000));
        assert!(!t.should_emit(t0 + Duration::from_millis(160), 102, 10_000));
    }

    #[test]
    fn leases_count_sessions() {
        let id = "lease-test-model";
        assert!(!is_leased(id));
        let a = ModelLease::new(id);
        let b = ModelLease::new(id);
        drop(a);
        assert!(is_leased(id));
        drop(b);
        assert!(!is_leased(id));
    }

    /// Serve `body` from a throwaway local HTTP server; returns its URL.
    async fn serve(body: Vec<u8>) -> String {
        let app = axum::Router::new().route(
            "/model.bin",
            axum::routing::get(move || {
                let body = body.clone();
                async move { body }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}/model.bin")
    }

    fn sha_hex(data: &[u8]) -> String {
        to_hex(&Sha256::digest(data))
    }

    #[tokio::test]
    async fn a_verified_download_lands_under_its_final_name() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let url = serve(body.clone()).await;
        let dir = scratch_dir("ok");
        let dest = dir.join("m.bin");
        let mut stages = Vec::new();
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &sha_hex(&body),
            &AtomicBool::new(false),
            |stage, _| stages.push(stage),
        )
        .await;
        assert_eq!(r, Ok(()));
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!part_path(&dest).exists());
        assert_eq!(stages.first(), Some(&Stage::Downloading));
        assert_eq!(stages.last(), Some(&Stage::Verifying));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_checksum_mismatch_leaves_nothing_behind() {
        let body = vec![7u8; 10_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("bad-sha");
        let dest = dir.join("m.bin");
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &"0".repeat(64),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Failed(m)) if m.contains("checksum")));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_short_download_is_rejected() {
        let body = vec![1u8; 1_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("short");
        let dest = dir.join("m.bin");
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            2_000,
            &sha_hex(&body),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Failed(m)) if m.contains("ended early")));
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_cancelled_download_deletes_its_part_file() {
        let body = vec![3u8; 50_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("cancel");
        let dest = dir.join("m.bin");
        let cancel = AtomicBool::new(false);
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &sha_hex(&body),
            &cancel,
            |_, _| cancel.store(true, Ordering::SeqCst),
        )
        .await;
        assert_eq!(r, Err(DownloadError::Cancelled));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real download of the smallest catalog model, skipped by default: run
    /// with PARLEY_LOCAL_STT_DIR set and `-- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn smoke_download_small_model() {
        let dir =
            PathBuf::from(std::env::var("PARLEY_LOCAL_STT_DIR").expect("PARLEY_LOCAL_STT_DIR"));
        let e = entry("whisper-small-q5_1").unwrap();
        let started = Instant::now();
        let mut throttle = Throttle::new();
        let mut events = 0u32;
        download_verified(
            &reqwest::Client::new(),
            &e.url(),
            &dir.join(e.file),
            e.bytes,
            e.sha256,
            &AtomicBool::new(false),
            |stage, received| {
                if stage != Stage::Downloading
                    || throttle.should_emit(Instant::now(), received, e.bytes)
                {
                    events += 1;
                }
            },
        )
        .await
        .unwrap();
        assert!(is_installed_in(&dir, e));
        println!(
            "downloaded in {} s, {events} progress events",
            started.elapsed().as_secs()
        );
    }
}
