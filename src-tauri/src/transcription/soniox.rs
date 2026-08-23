//! Soniox realtime adapter. Streams PCM over a WebSocket and parses Soniox's
//! token stream (with speaker diarization) into transcript segments.

use anyhow::{anyhow, Result};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, ensure_crypto_provider, LevelMeter,
    SegmentBuilder, TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsWrite = SplitSink<Ws, Message>;
type WsRead = SplitStream<Ws>;

/// Soniox endpoint markers. `<end>` closes an utterance; `<fin>` is the final
/// token emitted when the whole stream ends.
const TOKEN_END: &str = "<end>";
const TOKEN_FIN: &str = "<fin>";

#[derive(Serialize)]
struct SonioxConfig<'a> {
    /// Omitted in hosted "parley" relay mode — the relay injects the master key
    /// server-side, so the Soniox key never rides in the client's config frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<&'a str>,
    model: &'a str,
    audio_format: &'a str,
    sample_rate: u32,
    num_channels: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints: Option<Vec<String>>,
    enable_endpoint_detection: bool,
    enable_speaker_diarization: bool,
    /// Custom vocabulary biasing. Omitted entirely when the phrase dictionary is
    /// empty so the config frame stays byte-identical to what it was before —
    /// including through the hosted relay, which forwards this same frame.
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

/// What the read loop should do with one incoming websocket frame.
enum Frame {
    /// A JSON payload to parse.
    Payload(String),
    /// Nothing of interest — keep reading.
    Skip,
    /// The stream ended; stop reading.
    Stop,
}

/// Open the session's socket. Hosted "parley" relay (config.relay_endpoint set):
/// connect to the cloud WSS with a Bearer token instead of the vendor with an
/// api_key. Otherwise BYOK: straight to Soniox. Both yield the same Soniox wire
/// protocol.
async fn open_socket(config: &TranscribeConfig) -> Result<Ws> {
    let Some(relay_url) = &config.relay_endpoint else {
        ensure_crypto_provider();
        let (ws, _) = tokio_tungstenite::connect_async(SONIOX_WS_URL)
            .await
            .map_err(|e| anyhow!("connect failed: {e}"))?;
        return Ok(ws);
    };
    connect_with_headers(
        relay_url,
        &[("Authorization", format!("Bearer {}", config.api_key))],
    )
    .await
}

/// The opening config frame Soniox expects.
fn wire_config(config: &TranscribeConfig) -> SonioxConfig<'_> {
    let language_hints = if config.language_hints.is_empty() {
        None
    } else {
        Some(config.language_hints.clone())
    };
    SonioxConfig {
        // Relay mode omits the key (the relay injects it); BYOK sends it.
        api_key: if config.relay_endpoint.is_some() {
            None
        } else {
            Some(config.api_key.as_str())
        },
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
/// finalize and close. Resolves `true` when the input drained (normal stop) and
/// `false` when a send failed, i.e. the socket died under us — drive_session
/// reports that as a failure.
async fn forward_audio(
    mut write: WsWrite,
    mut meter: LevelMeter,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
    source: &'static str,
    is_relay: bool,
) -> bool {
    let mut total: u64 = 0;
    let mut next_log: u64 = TARGET_SAMPLE_RATE as u64;
    // Soniox closes with a 408 if it doesn't see traffic regularly; mirror
    // the SDK and send keep-alives on an interval.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(2));
    keepalive.tick().await;

    let drained = loop {
        tokio::select! {
            maybe_chunk = pcm_rx.recv() => {
                let Some(chunk) = maybe_chunk else { break true };
                meter.push(&chunk);
                total += chunk.len() as u64;
                if total >= next_log {
                    eprintln!("[soniox:{source}] TX {}s audio sent", total / TARGET_SAMPLE_RATE as u64);
                    next_log += TARGET_SAMPLE_RATE as u64;
                }
                let bytes = pcm_to_le_bytes(&chunk);
                if write.send(Message::Binary(bytes)).await.is_err() {
                    break false;
                }
            }
            _ = keepalive.tick() => {
                if write.send(Message::Text("{\"type\":\"keepalive\"}".to_string())).await.is_err() {
                    break false;
                }
            }
        }
    };
    let _ = write
        .send(Message::Text("{\"type\":\"finalize\"}".to_string()))
        .await;
    // BYOK: close our write half so Soniox flushes the final tokens to our
    // still-open read half and then ends. In hosted RELAY mode, do NOT close
    // here — the relay must forward this finalize to Soniox and stream the
    // flushed tail BACK to us first; closing now would make the relay's
    // server socket fire 'close' and stop relaying, truncating the last
    // utterance. The relay closes the socket once Soniox finishes, which ends
    // the read loop below (it also breaks on Soniox's `finished` marker).
    if !is_relay {
        let _ = write.close().await;
    }
    drained
}

/// Classify one websocket frame into "parse this" / "ignore" / "we're done".
fn classify(msg: Result<Message, tokio_tungstenite::tungstenite::Error>, source: &str) -> Frame {
    let msg = match msg {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[soniox:{source}] read error: {e}");
            return Frame::Stop;
        }
    };
    match msg {
        Message::Text(t) => Frame::Payload(t.to_string()),
        Message::Binary(b) => Frame::Payload(String::from_utf8_lossy(&b).into_owned()),
        Message::Close(frame) => {
            eprintln!("[soniox:{source}] socket closed by server: {frame:?}");
            Frame::Stop
        }
        _ => Frame::Skip,
    }
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
async fn read_transcripts(app: AppHandle, source: &'static str, mut read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    let mut msg_count: u64 = 0;

    while let Some(msg) = read.next().await {
        let payload = match classify(msg, source) {
            Frame::Payload(p) => p,
            Frame::Skip => continue,
            Frame::Stop => break,
        };
        msg_count += 1;
        if msg_count <= 3 {
            eprintln!("[soniox:{source}] RX raw#{msg_count}: {payload}");
        }

        let resp: SonioxResponse = match serde_json::from_str(&payload) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[soniox:{source}] RX parse error: {e} — payload: {payload}");
                continue;
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
        if resp.finished {
            break;
        }
    }
    Ok(())
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
    let ws = open_socket(&config).await?;
    let (mut write, read) = ws.split();

    write
        .send(Message::Text(serde_json::to_string(&wire_config(&config))?))
        .await?;
    eprintln!(
        "[soniox:{source}] connected, model={}, diarization={}, vocabulary={}",
        config.model,
        config.diarization,
        config.vocabulary.len()
    );

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);
    let is_relay = config.relay_endpoint.is_some();

    drive_session(
        "soniox",
        forward_audio(write, meter, pcm_rx, source, is_relay),
        read_transcripts(app, source, read),
    )
    .await
}
