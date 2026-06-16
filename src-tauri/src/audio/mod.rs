pub mod microphone;
pub mod mixer;
pub mod resample;
#[cfg(target_os = "macos")]
pub mod system_macos;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;
use tokio::sync::mpsc::UnboundedSender;

/// Target sample rate for everything we hand to Soniox (mono, s16le).
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// A capture backend that produces 16 kHz mono `i16` PCM on `tx` until `running`
/// is cleared. Implemented by [`microphone::Microphone`] today; the macOS Core
/// Audio system tap lands in M2, with ScreenCaptureKit and Windows WASAPI behind
/// the same trait afterwards.
pub trait AudioSource {
    /// Start capturing on a dedicated thread, returning its join handle. The
    /// thread runs until `running` becomes `false`, then releases the device.
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> anyhow::Result<JoinHandle<()>>;
}
