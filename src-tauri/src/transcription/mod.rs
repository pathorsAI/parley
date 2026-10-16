//! Transcription adapters. Each provider speaks its own wire protocol but
//! shares the primitives in [`common`] (segment building, level metering,
//! event emission) and the websocket plumbing in [`ws`] (audio pump, frame
//! classification, read loop).
//!
//! Which adapter serves a provider, and what that provider needs, is one row in
//! the [`provider`] registry. The dispatch contract is deliberately minimal: an
//! adapter is handed a PCM receiver and decides how to consume it. Today every
//! adapter streams audio to a realtime WebSocket, but the same signature
//! supports a future batch adapter that buffers from `pcm_rx`, chunks
//! internally, and posts to a non-streaming API — no change to callers.

pub mod assemblyai;
pub mod batch;
pub mod bridge;
pub mod common;
pub mod deepgram;
pub mod error;
pub mod gemini;
pub mod local;
pub mod openai;
pub mod parley;
pub mod provider;
pub mod reconnect;
pub mod request;
pub mod soniox;
pub mod ws;

use anyhow::Result;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

pub use common::TranscribeConfig;
pub use provider::SttProvider;
pub use request::{Entry, SessionRequest};

/// Dispatch a transcription session to the selected adapter.
pub async fn run_session(
    provider: SttProvider,
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    (provider.spec().live)(app, config, source, pcm_rx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_round_trip_and_unknown_ones_are_refused() {
        for id in [
            "soniox",
            "deepgram",
            "assemblyai",
            "openai",
            "gemini",
            "parley",
            "local",
        ] {
            assert_eq!(SttProvider::from_id(id).unwrap().id(), id);
        }
        assert_eq!(
            SttProvider::from_id("Soniox").unwrap_err().to_string(),
            "unknown stt provider: Soniox"
        );
    }

    #[test]
    fn provider_defaults_and_capabilities() {
        let row = |id: &str| {
            let p = SttProvider::from_id(id).unwrap();
            (p.default_model(), p.supports_diarization())
        };
        assert_eq!(row("soniox"), ("stt-rt-v5", true));
        assert_eq!(row("deepgram"), ("nova-3", true));
        assert_eq!(row("assemblyai"), ("", false));
        assert_eq!(row("openai"), ("gpt-4o-transcribe", false));
        assert_eq!(row("gemini"), ("gemini-2.0-flash-live-001", false));
        assert_eq!(row("parley"), ("", true));
        assert_eq!(row("local"), (crate::local_stt::DEFAULT_MODEL_ID, false));
    }
}
