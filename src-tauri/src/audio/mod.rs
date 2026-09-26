// Platform-neutral half of the Windows loopback source (sample conversion,
// silence padding, reopen policy) — compiled into tests everywhere so it is
// exercised on macOS CI as well.
#[cfg(any(target_os = "windows", test))]
pub mod loopback;
pub mod microphone;
// Two streams to sum only exist where a second stream exists at all: the macOS
// Core Audio process tap and Windows WASAPI loopback. Elsewhere a meeting
// records the microphone alone, so there is nothing for the mixer to mix.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod mixer;
pub mod prosody;
pub mod resample;
#[cfg(target_os = "macos")]
pub mod system_macos;
#[cfg(target_os = "windows")]
pub mod system_windows;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;
use tokio::sync::mpsc::UnboundedSender;

/// Target sample rate for everything we hand to Soniox (mono, s16le).
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// A capture backend that produces 16 kHz mono `i16` PCM on `tx` until `running`
/// is cleared. Implemented by [`microphone::Microphone`] on every platform and,
/// for the other side of a call, by the macOS Core Audio process tap
/// (`system_macos`) and Windows WASAPI loopback (`system_windows`).
pub trait AudioSource {
    /// Start capturing on a dedicated thread, returning its join handle. The
    /// thread runs until `running` becomes `false`, then releases the device.
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> anyhow::Result<JoinHandle<()>>;
}
