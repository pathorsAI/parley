//! Transcription adapters. Each provider speaks its own wire protocol but
//! shares the primitives in [`common`] (segment building, level metering,
//! event emission).
//!
//! The dispatch contract is deliberately minimal: an adapter is handed a PCM
//! receiver and decides how to consume it. Today every adapter streams audio to
//! a realtime WebSocket, but the same signature supports a future batch adapter
//! that buffers from `pcm_rx`, chunks internally, and posts to a non-streaming
//! API — no change to callers.

pub mod assemblyai;
pub mod common;
pub mod deepgram;
pub mod gemini;
pub mod openai;
pub mod soniox;

use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

pub use common::TranscribeConfig;

/// Which realtime transcription backend to route audio through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SttProvider {
    Soniox,
    Deepgram,
    AssemblyAI,
    OpenAI,
    Gemini,
}

impl SttProvider {
    /// Parse the frontend's provider id. Falls back to an error so callers can
    /// surface a clear message rather than silently picking a default.
    pub fn from_id(id: &str) -> Result<Self> {
        Ok(match id {
            "soniox" => Self::Soniox,
            "deepgram" => Self::Deepgram,
            "assemblyai" => Self::AssemblyAI,
            "openai" => Self::OpenAI,
            "gemini" => Self::Gemini,
            other => return Err(anyhow!("unknown stt provider: {other}")),
        })
    }

    /// Default realtime model id when the caller doesn't supply one.
    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Soniox => "stt-rt-v5",
            Self::Deepgram => "nova-3",
            Self::AssemblyAI => "", // single streaming model, no id needed
            Self::OpenAI => "gpt-4o-transcribe",
            Self::Gemini => "gemini-2.0-flash-live-001",
        }
    }

    /// Whether this backend can label speakers. Drives whether the UI offers
    /// per-speaker naming.
    pub fn supports_diarization(&self) -> bool {
        matches!(self, Self::Soniox | Self::Deepgram)
    }
}

/// Dispatch a transcription session to the selected adapter.
pub async fn run_session(
    provider: SttProvider,
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    match provider {
        SttProvider::Soniox => soniox::run_session(app, config, source, pcm_rx).await,
        SttProvider::Deepgram => deepgram::run_session(app, config, source, pcm_rx).await,
        SttProvider::AssemblyAI => assemblyai::run_session(app, config, source, pcm_rx).await,
        SttProvider::OpenAI => openai::run_session(app, config, source, pcm_rx).await,
        SttProvider::Gemini => gemini::run_session(app, config, source, pcm_rx).await,
    }
}
