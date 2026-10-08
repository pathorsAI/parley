//! Hosted "parley" adapter: Parley Cloud's own streaming protocol (v2).
//!
//! The wire contract lives in `docs/design/stt-protocol.md`. In short: a JSON
//! `start` frame, raw PCM as binary frames, `keepalive` / `end` text frames;
//! the server answers `ready`, then `transcript` frames (final tokens appended
//! once, non-final tokens replace the tentative tail), `endpoint` / `finalized`
//! markers, `done`, or an `error` with a stable code. Authentication is the
//! signed-in cloud session as a Bearer token on the upgrade request; a refused
//! upgrade is plain HTTP (401 / 402 / 429), which `connect_with_headers`
//! preserves in its error so the session's failure classification still sees
//! the status.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, note_connected, LevelMeter,
    SegmentBuilder, Timeline, TranscribeConfig, CONNECT_TIMEOUT, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

/// Log / error prefix for this adapter.
const NAME: &str = "parley";

/// The v1 streaming path, which older frontends may still hand us.
const V1_STREAM_PATH: &str = "/stt/stream";
/// The v2 streaming path this adapter speaks.
const V2_STREAM_PATH: &str = "/stt/v2/stream";

/// How often a keepalive goes out. Sent regardless of audio, so a paused
/// meeting (no audio flowing) never trips the server's idle window.
const KEEPALIVE_EVERY: Duration = Duration::from_secs(2);

/// The v2 stream URL for the configured cloud endpoint. The frontend already
/// passes the v2 URL; a v1 URL (`…/stt/stream?feature=…`) is rewritten so the
/// query string (billing attribution) survives either way.
pub fn stream_url(endpoint: &str) -> String {
    if endpoint.contains(V2_STREAM_PATH) {
        return endpoint.to_string();
    }
    match endpoint.find(V1_STREAM_PATH) {
        Some(at) => {
            let rest = &endpoint[at + V1_STREAM_PATH.len()..];
            // Only a whole path segment: `/stt/streams` is not the v1 path.
            if rest.is_empty() || rest.starts_with('?') || rest.starts_with('/') {
                format!("{}{V2_STREAM_PATH}{rest}", &endpoint[..at])
            } else {
                endpoint.to_string()
            }
        }
        None => endpoint.to_string(),
    }
}

// --- Client → server -----------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
struct AudioFormat {
    encoding: &'static str,
    sample_rate: u32,
    channels: u32,
}

#[derive(Serialize, Debug, PartialEq)]
struct Hints {
    terms: Vec<String>,
}

/// The opening `start` frame.
#[derive(Serialize, Debug, PartialEq)]
struct StartFrame {
    #[serde(rename = "type")]
    kind: &'static str,
    audio: AudioFormat,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    languages: Vec<String>,
    diarization: bool,
    endpointing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    hints: Option<Hints>,
}

fn start_frame(config: &TranscribeConfig) -> StartFrame {
    let terms = clean_vocabulary(&config.vocabulary);
    StartFrame {
        kind: "start",
        audio: AudioFormat {
            encoding: "pcm_s16le",
            sample_rate: TARGET_SAMPLE_RATE,
            channels: 1,
        },
        languages: config.language_hints.clone(),
        diarization: config.diarization,
        endpointing: true,
        hints: if terms.is_empty() {
            None
        } else {
            Some(Hints { terms })
        },
    }
}

const KEEPALIVE_FRAME: &str = "{\"type\":\"keepalive\"}";
const END_FRAME: &str = "{\"type\":\"end\"}";

// --- Server → client -----------------------------------------------------------

/// One recognized token. `speaker` is present only with diarization.
#[derive(Deserialize, Debug, Default, Clone, PartialEq)]
pub struct Token {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    #[serde(default, rename = "final")]
    pub is_final: bool,
    #[serde(default)]
    pub speaker: Option<i64>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

/// Every frame the server sends. Unknown types are tolerated (forward
/// compatibility), as are unknown fields.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerFrame {
    Ready {
        #[serde(default)]
        session_id: Option<String>,
    },
    Transcript {
        #[serde(default)]
        tokens: Vec<Token>,
    },
    Endpoint,
    Finalized,
    Done,
    Error {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
    #[serde(other)]
    Unknown,
}

fn parse_frame(payload: &str) -> Result<ServerFrame> {
    serde_json::from_str(payload).map_err(|e| anyhow!("unparseable frame: {e}"))
}

/// Turn an `error` frame into the session error. The text is what the
/// metered session classifies (see `capture::Failure::classify`): a hosted
/// failure carrying "402" is the quota UX, "401" the sign-in UX, and anything
/// else a connection failure a meeting redials through.
fn error_for(code: &str, message: &str) -> anyhow::Error {
    let detail = if message.is_empty() { code } else { message };
    match code {
        "quota_exceeded" => anyhow!("hosted transcription quota exceeded (402): {detail}"),
        "bad_request" => anyhow!("hosted transcription rejected the session (400): {detail}"),
        "idle_timeout" => anyhow!("hosted transcription idle timeout (408): {detail}"),
        "upstream_unavailable" => {
            anyhow!("hosted transcription service unavailable: {detail}")
        }
        "internal" => anyhow!("hosted transcription server error: {detail}"),
        other => anyhow!("hosted transcription error {other}: {detail}"),
    }
}

/// Map a server close that arrived without an `error` frame onto the same
/// errors (the close code mirrors the error code, see the protocol's table).
fn error_for_close(code: u16, reason: &str) -> anyhow::Error {
    match code {
        4402 => error_for("quota_exceeded", reason),
        4400 => error_for("bad_request", reason),
        4408 => error_for("idle_timeout", reason),
        1011 => error_for("upstream_unavailable", reason),
        other => anyhow!("hosted transcription closed by server ({other}): {reason}"),
    }
}

/// A settled token as the segment builder takes it.
#[derive(Debug, PartialEq)]
struct FinalToken<'a> {
    text: &'a str,
    speaker: i64,
    start_ms: u64,
    end_ms: u64,
}

/// The tentative tail of one `transcript` frame. `speaker`/`start_ms` are
/// `None` when the frame carried no non-final token (the caller then labels
/// the empty tail from its open run).
#[derive(Debug, Default, PartialEq)]
struct Tail {
    text: String,
    speaker: Option<i64>,
    start_ms: Option<u64>,
}

/// Split one frame's tokens into the final ones (in order) and the tentative
/// tail. Pure, so the mapping is testable without an `AppHandle`.
fn split_tokens(tokens: &[Token]) -> (Vec<FinalToken<'_>>, Tail) {
    let mut finals = Vec::new();
    let mut tail = Tail::default();
    for tok in tokens {
        let speaker = tok.speaker.unwrap_or(0);
        if tok.is_final {
            finals.push(FinalToken {
                text: &tok.text,
                speaker,
                start_ms: tok.start_ms,
                end_ms: tok.end_ms,
            });
        } else {
            if tail.start_ms.is_none() {
                tail.speaker = Some(speaker);
                tail.start_ms = Some(tok.start_ms);
            }
            tail.text.push_str(&tok.text);
        }
    }
    (finals, tail)
}

/// Fold one `transcript` frame into the builder and emit the result.
fn apply_tokens(builder: &mut SegmentBuilder, tokens: &[Token]) {
    let (finals, tail) = split_tokens(tokens);
    for tok in finals {
        builder.push_final(tok.text, tok.speaker, tok.start_ms, tok.end_ms);
    }
    builder.emit_committed();
    builder.emit_tail(
        &tail.text,
        tail.speaker.unwrap_or_else(|| builder.current_speaker()),
        tail.start_ms.unwrap_or_else(|| builder.current_end()),
    );
}

/// What the read loop does with one parsed frame.
#[derive(Debug, PartialEq)]
enum Step {
    Tokens,
    /// Close the open utterance (an `endpoint`, or `finalized`: every token
    /// so far is final).
    Endpoint,
    /// `done`: close the open utterance and stop reading.
    Done,
    Ignore,
}

///
/// `ended`: whether `end` was already sent. The server answers a recognizer
/// that never finishes after `end` with `upstream_unavailable`; by then every
/// final token has arrived and the user asked to stop, so that ends the
/// session normally (only the tentative tail is lost) instead of surfacing a
/// failure for a stop that already happened.
fn step_for(frame: &ServerFrame, ended: bool) -> Result<Step> {
    Ok(match frame {
        ServerFrame::Transcript { .. } => Step::Tokens,
        ServerFrame::Endpoint | ServerFrame::Finalized => Step::Endpoint,
        ServerFrame::Done => Step::Done,
        ServerFrame::Error { code, .. } if ended && code == "upstream_unavailable" => Step::Done,
        ServerFrame::Error { code, message } => return Err(error_for(code, message)),
        ServerFrame::Ready { .. } | ServerFrame::Unknown => Step::Ignore,
    })
}

/// Read until the server's `ready`: the session is accepted and the
/// recognizer is open. Bounded by the connect timeout, like the dial itself.
/// An `error` frame or a close before `ready` is the handshake's failure.
async fn await_ready(read: &mut WsRead, source: &'static str) -> Result<()> {
    let wait = async {
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Close(frame)) => {
                    return Err(match frame {
                        Some(f) if f.code != CloseCode::Normal => {
                            error_for_close(u16::from(f.code), &f.reason)
                        }
                        _ => anyhow!("hosted transcription closed before ready"),
                    });
                }
                Ok(_) => continue,
                Err(e) => return Err(anyhow!("connect failed: {e}")),
            };
            match parse_frame(&payload)? {
                ServerFrame::Ready { session_id } => {
                    eprintln!(
                        "[{NAME}:{source}] ready, session={}",
                        session_id.as_deref().unwrap_or("?")
                    );
                    return Ok(());
                }
                ServerFrame::Error { code, message } => return Err(error_for(&code, &message)),
                _ => continue,
            }
        }
        Err(anyhow!("hosted transcription closed before ready"))
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_elapsed) => Err(anyhow!("connect timed out")),
    }
}

/// Forward captured PCM with keepalives; on a normal stop send `end` and leave
/// the socket open so the flushed tail and `done` still reach the read half.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
    source: &'static str,
    ended: Arc<AtomicBool>,
) -> bool {
    let pump = Pump {
        keepalive: Some((KEEPALIVE_EVERY, KEEPALIVE_FRAME)),
        finish: Some(END_FRAME),
        close: false,
    };
    let mut total: u64 = 0;
    let mut next_log: u64 = TARGET_SAMPLE_RATE as u64;
    let drained = ws::forward_audio(write, meter, pcm_rx, pump, move |chunk| {
        total += chunk.len() as u64;
        if total >= next_log {
            eprintln!(
                "[{NAME}:{source}] TX {}s audio sent",
                total / TARGET_SAMPLE_RATE as u64
            );
            next_log += TARGET_SAMPLE_RATE as u64;
        }
        Message::Binary(pcm_to_le_bytes(chunk))
    })
    .await;
    // A drained pump has sent `end` (a failed one sent nothing more).
    ended.store(drained, Ordering::SeqCst);
    drained
}

/// Read frames into speaker-runs until `done` or the server closes. An `error`
/// frame (or an abnormal close) resolves to Err so the session's error surface
/// fires.
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
    ended: Arc<AtomicBool>,
) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT, timeline);
    let result = ws::read_frames(NAME, source, read, OnClose::FailIfAbnormal, |payload| {
        let frame = match parse_frame(payload) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[{NAME}:{source}] RX {e} — payload: {payload}");
                return Ok(Next::Continue);
            }
        };
        match step_for(&frame, ended.load(Ordering::SeqCst))? {
            // `tokens: []` is meaningful: the tentative tail is now empty, and
            // folding it emits the empty tail that clears it.
            Step::Tokens => {
                if let ServerFrame::Transcript { tokens } = &frame {
                    apply_tokens(&mut builder, tokens);
                }
                Ok(Next::Continue)
            }
            Step::Endpoint => {
                builder.endpoint();
                Ok(Next::Continue)
            }
            Step::Done => {
                builder.endpoint();
                Ok(Next::Stop)
            }
            Step::Ignore => Ok(Next::Continue),
        }
    })
    .await;
    // `read_frames` reports an abnormal close as "closed by server: <code>
    // <reason>"; give it the same wording as the matching error frame.
    result.map_err(|e| {
        let msg = e.to_string();
        match msg.strip_prefix("closed by server: ") {
            Some(rest) => {
                let (code, reason) = rest.split_once(' ').unwrap_or((rest, ""));
                match code.parse::<u16>() {
                    Ok(code) => error_for_close(code, reason),
                    Err(_) => e,
                }
            }
            None => e,
        }
    })
}

/// Run one hosted session: dial the cloud, send `start`, wait for `ready`,
/// then stream PCM from `pcm_rx` and emit `transcript://segment` events tagged
/// with `source`.
pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let endpoint = config
        .relay_endpoint
        .as_deref()
        .ok_or_else(|| anyhow!("hosted transcription requires the cloud endpoint"))?;
    let ws = connect_with_headers(
        &stream_url(endpoint),
        &[("Authorization", format!("Bearer {}", config.api_key))],
    )
    .await?;
    let (mut write, mut read) = ws.split();

    write
        .send(Message::Text(serde_json::to_string(&start_frame(&config))?))
        .await?;
    await_ready(&mut read, source).await?;
    eprintln!(
        "[{NAME}:{source}] connected, diarization={}, vocabulary={}, leg={}",
        config.diarization,
        config.vocabulary.len(),
        config.leg
    );
    note_connected(&app, source, config.leg);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);
    let ended = Arc::new(AtomicBool::new(false));
    drive_session(
        NAME,
        forward_audio(write, meter, pcm_rx, source, ended.clone()),
        read_transcripts(app, source, config.timeline(), read, ended),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TranscribeConfig {
        TranscribeConfig {
            api_key: "token".into(),
            model: String::new(),
            language_hints: vec!["zh".into(), "en".into()],
            diarization: true,
            vocabulary: vec![" Parley ".into(), "".into(), "派斯".into(), "Parley".into()],
            relay_endpoint: Some("wss://api.parley.tw/stt/v2/stream?feature=meeting".into()),
            leg: 0,
            time_offset_ms: 0,
            level_events: true,
        }
    }

    #[test]
    fn stream_url_upgrades_a_v1_endpoint_and_keeps_the_query() {
        assert_eq!(
            stream_url("wss://api.parley.tw/stt/stream?feature=meeting"),
            "wss://api.parley.tw/stt/v2/stream?feature=meeting"
        );
        assert_eq!(
            stream_url("wss://api.parley.tw/stt/stream"),
            "wss://api.parley.tw/stt/v2/stream"
        );
        assert_eq!(
            stream_url("wss://api.parley.tw/stt/v2/stream?feature=voice_typing"),
            "wss://api.parley.tw/stt/v2/stream?feature=voice_typing"
        );
        // Not the v1 path segment: left alone.
        assert_eq!(
            stream_url("ws://localhost:8787/stt/streams"),
            "ws://localhost:8787/stt/streams"
        );
    }

    #[test]
    fn the_start_frame_carries_languages_diarization_and_cleaned_terms() {
        let json = serde_json::to_value(start_frame(&config())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "start",
                "audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
                "languages": ["zh", "en"],
                "diarization": true,
                "endpointing": true,
                "hints": {"terms": ["Parley", "派斯"]},
            })
        );
    }

    #[test]
    fn the_start_frame_omits_empty_languages_and_hints() {
        let mut c = config();
        c.language_hints.clear();
        c.vocabulary = vec!["  ".into()];
        c.diarization = false;
        let json = serde_json::to_value(start_frame(&c)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "start",
                "audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
                "diarization": false,
                "endpointing": true,
            })
        );
    }

    #[test]
    fn parses_every_server_frame() {
        assert_eq!(
            parse_frame(r#"{"type":"ready","session_id":"s1"}"#).unwrap(),
            ServerFrame::Ready {
                session_id: Some("s1".into())
            }
        );
        assert_eq!(
            parse_frame(r#"{"type":"endpoint"}"#).unwrap(),
            ServerFrame::Endpoint
        );
        assert_eq!(
            parse_frame(r#"{"type":"finalized"}"#).unwrap(),
            ServerFrame::Finalized
        );
        assert_eq!(
            parse_frame(r#"{"type":"done"}"#).unwrap(),
            ServerFrame::Done
        );
        assert_eq!(
            parse_frame(r#"{"type":"error","code":"quota_exceeded","message":"cap"}"#).unwrap(),
            ServerFrame::Error {
                code: "quota_exceeded".into(),
                message: "cap".into()
            }
        );
        // Forward compatible: a new frame type, or extra fields, still parse.
        assert_eq!(
            parse_frame(r#"{"type":"something_new","x":1}"#).unwrap(),
            ServerFrame::Unknown
        );
        assert!(parse_frame("not json").is_err());
    }

    #[test]
    fn parses_a_transcript_frame_with_optional_token_fields() {
        let frame = parse_frame(
            r#"{"type":"transcript","final_audio_ms":320,"total_audio_ms":500,"tokens":[
                {"text":"你好","start_ms":0,"end_ms":320,"final":true,"speaker":1,"language":"zh","confidence":0.97},
                {"text":" there","start_ms":330,"end_ms":500,"final":false}
            ]}"#,
        )
        .unwrap();
        let ServerFrame::Transcript { tokens } = frame else {
            panic!("expected a transcript frame");
        };
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].text, "你好");
        assert!(tokens[0].is_final);
        assert_eq!(tokens[0].speaker, Some(1));
        assert_eq!(tokens[0].language.as_deref(), Some("zh"));
        assert_eq!(tokens[1].speaker, None);
        assert!(!tokens[1].is_final);
    }

    fn tok(text: &str, start: u64, end: u64, fin: bool, speaker: Option<i64>) -> Token {
        Token {
            text: text.into(),
            start_ms: start,
            end_ms: end,
            is_final: fin,
            speaker,
            ..Token::default()
        }
    }

    #[test]
    fn splits_final_tokens_from_the_tentative_tail() {
        let tokens = vec![
            tok("Hello", 0, 300, true, Some(1)),
            tok(" world", 300, 600, true, Some(2)),
            tok(" how", 650, 800, false, Some(2)),
            tok(" are", 800, 900, false, Some(2)),
        ];
        let (finals, tail) = split_tokens(&tokens);
        assert_eq!(
            finals,
            vec![
                FinalToken {
                    text: "Hello",
                    speaker: 1,
                    start_ms: 0,
                    end_ms: 300
                },
                FinalToken {
                    text: " world",
                    speaker: 2,
                    start_ms: 300,
                    end_ms: 600
                },
            ]
        );
        assert_eq!(
            tail,
            Tail {
                text: " how are".into(),
                speaker: Some(2),
                start_ms: Some(650)
            }
        );
    }

    #[test]
    fn tokens_without_a_speaker_are_speaker_zero_and_an_all_final_frame_clears_the_tail() {
        let tokens = vec![tok("hi", 0, 100, true, None)];
        let (finals, tail) = split_tokens(&tokens);
        assert_eq!(finals[0].speaker, 0);
        assert_eq!(tail, Tail::default());
    }

    #[test]
    fn markers_map_to_endpoints_and_done_stops() {
        assert_eq!(
            step_for(&ServerFrame::Endpoint, false).unwrap(),
            Step::Endpoint
        );
        assert_eq!(
            step_for(&ServerFrame::Finalized, false).unwrap(),
            Step::Endpoint
        );
        assert_eq!(step_for(&ServerFrame::Done, false).unwrap(), Step::Done);
        assert_eq!(
            step_for(&ServerFrame::Transcript { tokens: vec![] }, false).unwrap(),
            Step::Tokens
        );
        assert_eq!(
            step_for(&ServerFrame::Ready { session_id: None }, false).unwrap(),
            Step::Ignore
        );
        assert_eq!(
            step_for(&ServerFrame::Unknown, false).unwrap(),
            Step::Ignore
        );
    }

    #[test]
    fn error_codes_map_onto_the_session_error_kinds() {
        // `capture::Failure::classify` keys hosted failures on these numbers:
        // "402" is the quota UX; anything without 401/402 is a retryable
        // connection failure.
        let quota = step_for(
            &ServerFrame::Error {
                code: "quota_exceeded".into(),
                message: "Monthly quota used up".into(),
            },
            false,
        )
        .unwrap_err()
        .to_string();
        assert!(quota.contains("402"), "{quota}");
        assert!(quota.contains("Monthly quota used up"));

        for code in [
            "bad_request",
            "idle_timeout",
            "upstream_unavailable",
            "internal",
            "new_code",
        ] {
            let msg = error_for(code, "").to_string();
            assert!(
                !msg.contains("401") && !msg.contains("402"),
                "{code}: {msg}"
            );
            // An empty message still says which code it was.
            assert!(msg.contains(code) || msg.contains("(4"), "{code}: {msg}");
        }
    }

    #[test]
    fn a_recognizer_that_never_finishes_after_end_ends_the_session_normally() {
        let late = ServerFrame::Error {
            code: "upstream_unavailable".into(),
            message: "The recognizer did not finish".into(),
        };
        assert_eq!(step_for(&late, true).unwrap(), Step::Done);
        // Mid-session it is a failure (a meeting redials through it).
        assert!(step_for(&late, false).is_err());
        // Other errors stay errors even after `end`.
        let quota = ServerFrame::Error {
            code: "quota_exceeded".into(),
            message: String::new(),
        };
        assert!(step_for(&quota, true).is_err());
    }

    #[test]
    fn an_empty_transcript_frame_clears_the_tail() {
        let frame = parse_frame(r#"{"type":"transcript","tokens":[]}"#).unwrap();
        assert_eq!(step_for(&frame, false).unwrap(), Step::Tokens);
        let ServerFrame::Transcript { tokens } = frame else {
            panic!("expected a transcript frame");
        };
        let (finals, tail) = split_tokens(&tokens);
        assert!(finals.is_empty());
        assert_eq!(tail.text, "");
    }

    #[test]
    fn close_codes_without_an_error_frame_map_like_the_error_codes() {
        assert!(error_for_close(4402, "cap").to_string().contains("402"));
        assert!(error_for_close(4408, "").to_string().contains("idle"));
        assert!(error_for_close(1011, "")
            .to_string()
            .contains("unavailable"));
        assert!(error_for_close(4999, "x").to_string().contains("4999"));
    }
}
