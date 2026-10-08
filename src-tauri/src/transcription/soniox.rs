//! Soniox realtime adapter. Streams PCM over a WebSocket and parses Soniox's
//! token stream (with speaker diarization) into transcript segments.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, ensure_crypto_provider, note_connected,
    with_connect_timeout, LevelMeter, SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT,
    TRANSCRIPT_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, Ws, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

/// Soniox control tokens. `<end>` closes an utterance (endpoint detection);
/// `<fin>` acknowledges our `{"type":"finalize"}`: every token for the audio
/// sent before it has been returned as final. End of stream is the response's
/// `finished` flag, which Soniox only sends after an empty end-of-audio frame.
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

/// Open the session's socket. Hosted "parley" relay (config.relay_endpoint set):
/// connect to the cloud WSS with a Bearer token instead of the vendor with an
/// api_key. Otherwise BYOK: straight to Soniox. Both yield the same Soniox wire
/// protocol. Either dial is bounded by `common::CONNECT_TIMEOUT`.
async fn open_socket(config: &TranscribeConfig) -> Result<Ws> {
    let Some(relay_url) = &config.relay_endpoint else {
        ensure_crypto_provider();
        let (ws, _) = with_connect_timeout(async {
            tokio_tungstenite::connect_async(SONIOX_WS_URL)
                .await
                .map_err(|e| anyhow!("connect failed: {e}"))
        })
        .await?;
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
/// finalize and close.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
    source: &'static str,
    is_relay: bool,
) -> bool {
    let pump = Pump {
        // Soniox closes with a 408 if it doesn't see traffic regularly; mirror
        // the SDK and send keep-alives on an interval.
        keepalive: Some((
            std::time::Duration::from_secs(2),
            "{\"type\":\"keepalive\"}",
        )),
        finish: Some("{\"type\":\"finalize\"}"),
        // BYOK: close our write half so Soniox flushes the final tokens to our
        // still-open read half and then ends. In hosted RELAY mode, do NOT close
        // here — the relay must forward this finalize to Soniox and stream the
        // flushed tail BACK to us first; closing now would make the relay's
        // server socket fire 'close' and stop relaying, truncating the last
        // utterance. The relay neither closes the socket after the finalize nor
        // sends `finished`, so the read loop ends on the `<fin>` that answers
        // this finalize instead (see `ends_stream`) — in both modes.
        close: !is_relay,
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

/// Whether this response ends the stream for us: Soniox's `finished`, or the
/// `<fin>` acknowledging our closing finalize. Every token for audio sent
/// before the finalize is final by then and nothing more will come. The hosted
/// relay does not close the socket afterwards, so waiting for the close meant
/// waiting for stop_voice_typing's 8 s abort — which skipped `stt://closed` and
/// `usage://stt` for every hosted dictation and meeting.
fn ends_stream(resp: &SonioxResponse) -> bool {
    resp.finished || resp.tokens.iter().any(|t| t.text == TOKEN_FIN)
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

        // Decided before the tokens are applied, but acted on after: the
        // response that carries `<fin>` also carries the last finals, which
        // must be emitted (and committed by the endpoint) before we stop.
        let done = ends_stream(&resp);
        if apply_tokens(&mut builder, &resp.tokens) {
            builder.endpoint();
        }
        if done && !resp.finished {
            // Confirms in the field that the relay forwards `<fin>`; without
            // this line the session would end on DRAIN_READ_GRACE instead.
            log::info!("[soniox:{source}] finalize acknowledged; ending the stream");
        }
        Ok(if done { Next::Stop } else { Next::Continue })
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
    let connecting = std::time::Instant::now();
    let ws = open_socket(&config).await?;
    let (mut write, read) = ws.split();

    write
        .send(Message::Text(serde_json::to_string(&wire_config(&config))?))
        .await?;
    // To parley.log (an `eprintln!` never got there), so a "my name is ignored"
    // report can be checked against what actually went on the wire: the COUNT
    // of terms sent after cleaning, never the terms themselves (user data).
    // The connect time is the other half of a short dictation's wait: no token
    // can come back before it, and through the relay it is two hops.
    log::info!(
        "[soniox:{source}] connected in {}ms, model={}, diarization={}, relay={}, vocabulary={}, leg={}",
        connecting.elapsed().as_millis(),
        config.model,
        config.diarization,
        config.relay_endpoint.is_some(),
        clean_vocabulary(&config.vocabulary).len(),
        config.leg
    );
    // Soniox answers the closing finalize with `<fin>` (both modes), which
    // ends the stream; see `ends_stream`.
    note_connected(&app, source, config.leg, true);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);
    let is_relay = config.relay_endpoint.is_some();

    drive_session(
        "soniox",
        forward_audio(write, meter, pcm_rx, source, is_relay),
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(relay: Option<&str>, vocabulary: &[&str]) -> TranscribeConfig {
        TranscribeConfig {
            api_key: "sk-test".to_string(),
            model: "stt-rt-v3".to_string(),
            language_hints: vec!["zh".to_string(), "en".to_string()],
            diarization: false,
            vocabulary: vocabulary.iter().map(|t| t.to_string()).collect(),
            relay_endpoint: relay.map(str::to_string),
            leg: 0,
            time_offset_ms: 0,
            level_events: true,
        }
    }

    #[test]
    fn relay_frame_carries_cleaned_terms_and_no_key() {
        let cfg = config(Some("wss://example/stt"), &[" 名字 ", "Parley", "Parley"]);
        let frame = serde_json::to_value(wire_config(&cfg)).unwrap();
        // The relay injects the key server-side; it must never ride in the frame.
        assert!(frame.get("api_key").is_none());
        assert_eq!(frame["context"]["terms"], json!(["名字", "Parley"]));
    }

    #[test]
    fn byok_frame_carries_the_key() {
        let cfg = config(None, &["Parley"]);
        let frame = serde_json::to_value(wire_config(&cfg)).unwrap();
        assert_eq!(frame["api_key"], json!("sk-test"));
        assert_eq!(frame["context"]["terms"], json!(["Parley"]));
    }

    fn response(raw: serde_json::Value) -> SonioxResponse {
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn plain_finals_do_not_end_the_stream() {
        let resp = response(json!({
            "tokens": [
                { "text": "你好", "is_final": true, "start_ms": 0, "end_ms": 300 },
                { "text": "嗎", "is_final": false, "start_ms": 300, "end_ms": 400 }
            ]
        }));
        assert!(!ends_stream(&resp));
    }

    #[test]
    fn an_endpoint_does_not_end_the_stream() {
        let resp = response(json!({
            "tokens": [
                { "text": "你好。", "is_final": true },
                { "text": "<end>", "is_final": true }
            ]
        }));
        assert!(!ends_stream(&resp));
    }

    /// The hosted relay's only end-of-stream signal: the finalize's answer.
    #[test]
    fn the_finalize_acknowledgement_ends_the_stream() {
        let resp = response(json!({
            "tokens": [
                { "text": "明天見", "is_final": true, "start_ms": 900, "end_ms": 1300 },
                { "text": "<fin>", "is_final": true }
            ]
        }));
        assert!(ends_stream(&resp));
    }

    #[test]
    fn finished_ends_the_stream() {
        let resp = response(json!({ "tokens": [], "finished": true }));
        assert!(ends_stream(&resp));
    }

    #[test]
    fn empty_vocabulary_omits_context() {
        let cfg = config(Some("wss://example/stt"), &["  ", ""]);
        let frame = serde_json::to_value(wire_config(&cfg)).unwrap();
        assert!(frame.get("context").is_none());
        let cfg = config(None, &[]);
        let frame = serde_json::to_value(wire_config(&cfg)).unwrap();
        assert!(frame.get("context").is_none());
    }
}
