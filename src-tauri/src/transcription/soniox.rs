//! Soniox realtime adapter. Streams PCM over a WebSocket and parses Soniox's
//! token stream (with speaker diarization) into transcript segments.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, drive_session, ensure_crypto_provider, note_connected, with_connect_timeout,
    LevelMeter, SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, Ws, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

/// Soniox endpoint markers. `<end>` closes an utterance; `<fin>` is the final
/// token emitted when the whole stream ends.
const TOKEN_END: &str = "<end>";
const TOKEN_FIN: &str = "<fin>";

#[derive(Serialize)]
struct SonioxConfig<'a> {
    api_key: &'a str,
    model: &'a str,
    audio_format: &'a str,
    sample_rate: u32,
    num_channels: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints: Option<Vec<String>>,
    enable_endpoint_detection: bool,
    enable_speaker_diarization: bool,
    /// Custom vocabulary biasing. Omitted entirely when the phrase dictionary is
    /// empty so the config frame stays byte-identical to what it was before.
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<SonioxContext>,
}

/// Soniox's recognition-context object: the domain terms to bias toward.
#[derive(Serialize)]
pub struct SonioxContext {
    pub terms: Vec<String>,
}

/// Build the `context` field from the phrase dictionary — `None` when there is
/// nothing to bias toward. Shared with the batch (replay) path so both requests
/// carry the same shape.
pub fn context_for(vocabulary: &[String]) -> Option<SonioxContext> {
    let terms = clean_vocabulary(vocabulary);
    if terms.is_empty() {
        None
    } else {
        Some(SonioxContext { terms })
    }
}

#[derive(Deserialize, Default)]
struct SonioxToken {
    #[serde(default)]
    text: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    start_ms: u64,
    #[serde(default)]
    end_ms: u64,
    /// Diarized speaker — Soniox sends this as a STRING (e.g. "1"), or omits it
    /// on control tokens like `<end>`. Parsed to a number in the read loop.
    #[serde(default)]
    speaker: String,
}

#[derive(Deserialize, Default)]
struct SonioxResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    error_code: Option<i64>,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    finished: bool,
}

/// Open the session's socket, straight to Soniox with the user's own key (it
/// rides in the config frame). Bounded by `common::CONNECT_TIMEOUT`.
async fn open_socket() -> Result<Ws> {
    ensure_crypto_provider();
    let (ws, _) = with_connect_timeout(async {
        tokio_tungstenite::connect_async(SONIOX_WS_URL)
            .await
            .map_err(|e| anyhow!("connect failed: {e}"))
    })
    .await?;
    Ok(ws)
}

/// The opening config frame Soniox expects.
fn wire_config(config: &TranscribeConfig) -> SonioxConfig<'_> {
    let language_hints = if config.language_hints.is_empty() {
        None
    } else {
        Some(config.language_hints.clone())
    };
    SonioxConfig {
        api_key: &config.api_key,
        model: &config.model,
        audio_format: "pcm_s16le",
        sample_rate: TARGET_SAMPLE_RATE,
        num_channels: 1,
        language_hints,
        enable_endpoint_detection: true,
        enable_speaker_diarization: config.diarization,
        context: context_for(&config.vocabulary),
    }
}

/// Forward captured PCM, emit a level meter, keep the session alive, then
/// finalize and close.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
    source: &'static str,
) -> bool {
    let pump = Pump {
        // Soniox closes with a 408 if it doesn't see traffic regularly; mirror
        // the SDK and send keep-alives on an interval.
        keepalive: Some((
            std::time::Duration::from_secs(2),
            "{\"type\":\"keepalive\"}",
        )),
        finish: Some("{\"type\":\"finalize\"}"),
        // Close our write half so Soniox flushes the final tokens to our
        // still-open read half and then ends.
        close: true,
    };

    let mut total: u64 = 0;
    let mut next_log: u64 = TARGET_SAMPLE_RATE as u64;
    ws::forward_audio(write, meter, pcm_rx, pump, move |chunk| {
        total += chunk.len() as u64;
        if total >= next_log {
            eprintln!(
                "[soniox:{source}] TX {}s audio sent",
                total / TARGET_SAMPLE_RATE as u64
            );
            next_log += TARGET_SAMPLE_RATE as u64;
        }
        Message::Binary(pcm_to_le_bytes(chunk))
    })
    .await
}

/// Split one response's tokens into committed speaker-runs (pushed straight into
/// `builder`) and the tentative tail, then emit both. Returns whether the batch
/// carried an endpoint marker.
fn apply_tokens(builder: &mut SegmentBuilder, tokens: &[SonioxToken]) -> bool {
    let mut tail = String::new();
    let mut tail_speaker = builder.current_speaker();
    let mut tail_start = builder.current_end();
    let mut endpoint = false;

    for tok in tokens {
        if tok.text == TOKEN_END || tok.text == TOKEN_FIN {
            endpoint = true;
            continue;
        }
        let spk: i64 = tok.speaker.parse().unwrap_or(0);
        if tok.is_final {
            builder.push_final(&tok.text, spk, tok.start_ms, tok.end_ms);
        } else {
            if tail.is_empty() {
                tail_speaker = spk;
                tail_start = tok.start_ms;
            }
            tail.push_str(&tok.text);
        }
    }

    builder.emit_committed();
    builder.emit_tail(&tail, tail_speaker, tail_start);
    endpoint
}

/// Read tokens → speaker-runs via the shared SegmentBuilder. Resolves to Err on
/// an in-band error frame (e.g. a rejected api key) so the caller's error
/// surface fires — the session is dead from that point, and returning Ok would
/// leave the UI listening to nothing.
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT, timeline);
    ws::read_frames("soniox", source, read, OnClose::Stop, |payload| {
        let resp: SonioxResponse = match serde_json::from_str(payload) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[soniox:{source}] RX parse error: {e} — payload: {payload}");
                return Ok(Next::Continue);
            }
        };

        if let Some(code) = resp.error_code {
            let detail = resp.error_message.unwrap_or_default();
            eprintln!("[soniox:{source}] error {code}: {detail}");
            return Err(anyhow!("server error {code}: {detail}"));
        }

        if apply_tokens(&mut builder, &resp.tokens) {
            builder.endpoint();
        }
        Ok(if resp.finished {
            Next::Stop
        } else {
            Next::Continue
        })
    })
    .await
}

/// Run one Soniox realtime session: stream PCM from `pcm_rx`, parse the token
/// stream, and emit `transcript://segment` events tagged with `source`
/// ("me" for mic, "them" for system audio).
pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let ws = open_socket().await?;
    let (mut write, read) = ws.split();

    write
        .send(Message::Text(serde_json::to_string(&wire_config(&config))?))
        .await?;
    eprintln!(
        "[soniox:{source}] connected, model={}, diarization={}, vocabulary={}, leg={}",
        config.model,
        config.diarization,
        config.vocabulary.len(),
        config.leg
    );
    note_connected(&app, source, config.leg);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);

    drive_session(
        "soniox",
        forward_audio(write, meter, pcm_rx, source),
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}
