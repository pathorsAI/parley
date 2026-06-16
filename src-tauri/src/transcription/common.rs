//! Shared building blocks for transcription adapters.
//!
//! Every provider speaks its own wire protocol, but they all funnel results
//! through the same primitives here: a [`SegmentBuilder`] that groups finalized
//! tokens into speaker-runs and emits `transcript://segment` events, a
//! [`LevelMeter`] that emits `audio://level`, and small connect/emit helpers.
//!
//! Diarization is optional: adapters that can't tell speakers apart simply pass
//! `speaker = 0` for everything, which the UI renders as a single speaker.

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::TARGET_SAMPLE_RATE;

/// Event the frontend listens on for transcript updates (see tauriEvents.ts).
pub const TRANSCRIPT_EVENT: &str = "transcript://segment";
/// Event the frontend listens on for the live input-level meter.
pub const LEVEL_EVENT: &str = "audio://level";

/// rustls 0.23 requires a process-wide default CryptoProvider before any TLS
/// handshake; installing it lazily (once) avoids a panic in the ws task.
pub fn ensure_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Provider-agnostic session configuration handed to every adapter. Adapters
/// take what they need and ignore the rest (e.g. a provider without speaker
/// diarization ignores `diarization`).
#[derive(Clone)]
pub struct TranscribeConfig {
    pub api_key: String,
    pub model: String,
    /// BCP-47 hints (e.g. ["en", "zh"]); empty = let the provider auto-detect.
    pub language_hints: Vec<String>,
    /// Whether the caller wants speaker diarization; adapters that don't support
    /// it just emit speaker 0.
    pub diarization: bool,
}

/// Payload emitted to the frontend for each transcript update.
#[derive(Clone, Serialize)]
struct TranscriptEvent {
    id: String,
    source: String,
    /// Diarized speaker number within this source (0 = unknown / single speaker).
    speaker: i64,
    text: String,
    is_final: bool,
    start_ms: u64,
    end_ms: u64,
}

/// Live input level (0.0–1.0) emitted ~10×/s so the UI can show a meter.
#[derive(Clone, Serialize)]
struct LevelEvent {
    source: String,
    level: f32,
}

/// Emit a single transcript segment update to the frontend.
#[allow(clippy::too_many_arguments)]
pub fn emit_segment(
    app: &AppHandle,
    source: &str,
    id: String,
    speaker: i64,
    text: String,
    is_final: bool,
    start_ms: u64,
    end_ms: u64,
) {
    let _ = app.emit(
        TRANSCRIPT_EVENT,
        TranscriptEvent {
            id,
            source: source.to_string(),
            speaker,
            text,
            is_final,
            start_ms,
            end_ms,
        },
    );
}

/// Open a WebSocket with extra request headers (provider auth lives here).
pub async fn connect_with_headers(
    url: &str,
    headers: &[(&str, String)],
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    ensure_crypto_provider();
    let mut req = url
        .into_client_request()
        .map_err(|e| anyhow!("bad ws url: {e}"))?;
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| anyhow!("bad header {k}: {e}"))?;
        let val = HeaderValue::from_str(v).map_err(|e| anyhow!("bad header value: {e}"))?;
        req.headers_mut().insert(name, val);
    }
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    Ok(ws)
}

/// Tracks the peak of the captured PCM and emits a ~10 Hz level event. Adapters
/// call [`LevelMeter::push`] for every PCM chunk they forward.
pub struct LevelMeter {
    app: AppHandle,
    source: &'static str,
    peak: i32,
    samples: u64,
    window: u64,
}

impl LevelMeter {
    pub fn new(app: AppHandle, source: &'static str) -> Self {
        Self {
            app,
            source,
            peak: 0,
            samples: 0,
            // 16 kHz / 1600 = 10 windows per second.
            window: TARGET_SAMPLE_RATE as u64 / 10,
        }
    }

    pub fn push(&mut self, chunk: &[i16]) {
        for &s in chunk {
            self.peak = self.peak.max((s as i32).abs());
        }
        self.samples += chunk.len() as u64;
        if self.samples >= self.window {
            let level = (self.peak as f32 / 32767.0).clamp(0.0, 1.0);
            let _ = self.app.emit(
                LEVEL_EVENT,
                LevelEvent {
                    source: self.source.to_string(),
                    level,
                },
            );
            self.peak = 0;
            self.samples = 0;
        }
    }
}

/// Accumulates finalized tokens into speaker-runs and emits committed segments
/// plus a tentative tail. Shared by every adapter so the diarization-optional
/// behaviour (speaker change splits a run; speaker 0 never splits) lives in one
/// place.
///
/// Per server message an adapter typically does:
/// 1. `push_final(text, speaker, start, end)` for each settled token/turn,
/// 2. `emit_committed()` to surface the open run as solid text,
/// 3. `emit_tail(interim, speaker, start)` for the tentative tail,
/// 4. `endpoint()` when the provider signals end-of-utterance.
pub struct SegmentBuilder {
    app: AppHandle,
    source: &'static str,
    seg_index: u64,
    cur_speaker: i64, // -1 = no open run
    cur_final: String,
    cur_start: u64,
    cur_end: u64,
}

impl SegmentBuilder {
    pub fn new(app: AppHandle, source: &'static str) -> Self {
        Self {
            app,
            source,
            seg_index: 0,
            cur_speaker: -1,
            cur_final: String::new(),
            cur_start: 0,
            cur_end: 0,
        }
    }

    /// True while there is an open (uncommitted) run.
    pub fn has_open_run(&self) -> bool {
        self.cur_speaker != -1
    }

    /// The current open run's speaker (0 if none open) — useful for tail labels.
    pub fn current_speaker(&self) -> i64 {
        self.cur_speaker.max(0)
    }

    /// The end timestamp of the current open run — useful as a tail start.
    pub fn current_end(&self) -> u64 {
        self.cur_end
    }

    /// Add a finalized token to the run. A speaker change closes the open run
    /// (emitting it solid) and starts a new one. Whitespace is preserved as the
    /// adapter supplies it.
    pub fn push_final(&mut self, text: &str, speaker: i64, start_ms: u64, end_ms: u64) {
        if self.cur_speaker == -1 {
            self.cur_speaker = speaker;
            self.cur_start = start_ms;
        } else if speaker != self.cur_speaker {
            if !self.cur_final.trim().is_empty() {
                self.commit();
            }
            self.cur_speaker = speaker;
            self.cur_final.clear();
            self.cur_start = start_ms;
        }
        self.cur_final.push_str(text);
        self.cur_end = end_ms;
    }

    /// Emit the open run under a fresh segment id and advance the index.
    fn commit(&mut self) {
        emit_segment(
            &self.app,
            self.source,
            format!("{}-{}", self.source, self.seg_index),
            self.cur_speaker,
            self.cur_final.clone(),
            true,
            self.cur_start,
            self.cur_end,
        );
        self.seg_index += 1;
    }

    /// Surface the current open run as solid (settled) text without advancing —
    /// it keeps growing under the same id until an endpoint or speaker change.
    pub fn emit_committed(&self) {
        if !self.cur_final.trim().is_empty() {
            emit_segment(
                &self.app,
                self.source,
                format!("{}-{}", self.source, self.seg_index),
                self.cur_speaker,
                self.cur_final.clone(),
                true,
                self.cur_start,
                self.cur_end,
            );
        }
    }

    /// Emit the tentative tail under a stable `{source}-tail` id (empty text
    /// clears the previous tail in the UI).
    pub fn emit_tail(&self, text: &str, speaker: i64, start_ms: u64) {
        emit_segment(
            &self.app,
            self.source,
            format!("{}-tail", self.source),
            speaker,
            text.to_string(),
            false,
            start_ms,
            start_ms,
        );
    }

    /// End-of-utterance: commit the open run (if any) and reset for the next one.
    pub fn endpoint(&mut self) {
        if !self.cur_final.trim().is_empty() {
            self.commit();
        }
        self.cur_speaker = -1;
        self.cur_final.clear();
    }
}
