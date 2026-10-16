//! Transcription adapters. Each provider speaks its own wire protocol but
//! shares the primitives in [`common`] (segment building, level metering,
//! event emission) and the websocket plumbing in [`ws`] (audio pump, frame
//! classification, read loop).
//!
//! The dispatch contract is deliberately minimal: an adapter is handed a PCM
//! receiver and decides how to consume it. Today every adapter streams audio to
//! a realtime WebSocket, but the same signature supports a future batch adapter
//! that buffers from `pcm_rx`, chunks internally, and posts to a non-streaming
//! API — no change to callers.

pub mod assemblyai;
pub mod bridge;
pub mod common;
pub mod deepgram;
pub mod gemini;
pub mod local;
pub mod openai;
pub mod parley;
pub mod reconnect;
pub mod soniox;
pub mod ws;

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
    /// Hosted account mode: Parley Cloud's own streaming protocol (cloud WSS
    /// URL + Bearer session token, no provider key) — see
    /// [`TranscribeConfig::relay_endpoint`] and `parley::run_session`.
    Parley,
    /// On-device whisper.cpp — no network, no key; `model` is a catalog id
    /// from `local_stt::CATALOG`. See `local::run_session`.
    Local,
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
            "parley" => Self::Parley,
            "local" => Self::Local,
            other => return Err(anyhow!("unknown stt provider: {other}")),
        })
    }

    /// Stable string id used by the frontend and the usage log.
    pub fn id(&self) -> &'static str {
        match self {
            Self::Soniox => "soniox",
            Self::Deepgram => "deepgram",
            Self::AssemblyAI => "assemblyai",
            Self::OpenAI => "openai",
            Self::Gemini => "gemini",
            Self::Parley => "parley",
            Self::Local => "local",
        }
    }

    /// Default realtime model id when the caller doesn't supply one.
    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Soniox => "stt-rt-v5",
            Self::Deepgram => "nova-3",
            Self::AssemblyAI => "", // single streaming model, no id needed
            Self::OpenAI => "gpt-4o-transcribe",
            Self::Gemini => "gemini-2.0-flash-live-001",
            // The cloud picks the model; the protocol carries none.
            Self::Parley => "",
            Self::Local => crate::local_stt::DEFAULT_MODEL_ID,
        }
    }

    /// Whether this backend can label speakers. Drives whether the UI offers
    /// per-speaker naming.
    pub fn supports_diarization(&self) -> bool {
        // The hosted service diarizes on request (the `start` frame's flag).
        matches!(self, Self::Soniox | Self::Deepgram | Self::Parley)
    }
}

/// The checks a live session start (a meeting or a dictation) must pass before
/// it claims the microphone. `has_relay`: the caller passed a cloud relay URL.
/// The local-model check needs the app's paths and stays with the callers.
pub fn check_live_start(
    provider: SttProvider,
    api_key: &str,
    has_relay: bool,
) -> Result<(), String> {
    // The on-device provider has no key (the frontend sends a placeholder).
    if provider != SttProvider::Local && api_key.trim().is_empty() {
        return Err("missing transcription API key".into());
    }
    // Hosted mode's api_key is the cloud session token, which only the relay
    // accepts — streaming it straight to the vendor dies with an opaque
    // in-band auth error. Refuse loudly instead (a call site that forgot
    // relayUrl is a frontend bug).
    if provider == SttProvider::Parley && !has_relay {
        return Err("hosted transcription requires the cloud relay URL".into());
    }
    Ok(())
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
        SttProvider::Parley => parley::run_session(app, config, source, pcm_rx).await,
        SttProvider::Local => local::run_session(app, config, source, pcm_rx).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(id: &str, key: &str, relay: bool) -> Result<(), String> {
        check_live_start(SttProvider::from_id(id).unwrap(), key, relay)
    }

    #[test]
    fn a_live_start_without_a_key_is_refused_unless_on_device() {
        for id in [
            "soniox",
            "deepgram",
            "assemblyai",
            "openai",
            "gemini",
            "parley",
        ] {
            assert_eq!(
                start(id, "  ", true),
                Err("missing transcription API key".to_string()),
                "{id}"
            );
            assert_eq!(start(id, "k", true), Ok(()), "{id}");
        }
        assert_eq!(start("local", "", false), Ok(()));
    }

    #[test]
    fn hosted_mode_needs_the_relay_and_nothing_else_does() {
        assert_eq!(
            start("parley", "token", false),
            Err("hosted transcription requires the cloud relay URL".to_string())
        );
        // The key check comes first.
        assert_eq!(
            start("parley", "", false),
            Err("missing transcription API key".to_string())
        );
        for id in ["soniox", "deepgram", "assemblyai", "openai", "gemini"] {
            assert_eq!(start(id, "k", false), Ok(()), "{id}");
        }
    }

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
