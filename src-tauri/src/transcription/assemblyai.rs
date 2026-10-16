//! AssemblyAI streaming (v3) adapter. Streams pcm_s16le over a WebSocket and
//! turns each formatted "Turn" into a transcript segment.
//!
//! Note: v3 streaming does not provide speaker diarization, so every segment is
//! emitted under speaker 0 (a single speaker in the UI).

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, note_connected, urlencode, LevelMeter,
    SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, WsRead};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const AAI_BASE: &str = "wss://streaming.assemblyai.com/v3/ws";

/// Universal-Streaming's custom-vocabulary query param, ready to append to the
/// v3 websocket URL. The wire shape is `keyterms_prompt=<JSON array of terms>`,
/// url-encoded — note the JSON array, not a repeated param (that is the v3
/// streaming spelling; the batch API instead takes a `word_boost` body array).
/// Empty string when there's nothing to bias toward.
pub fn keyterms_param(vocabulary: &[String]) -> String {
    let terms = clean_vocabulary(vocabulary);
    if terms.is_empty() {
        return String::new();
    }
    match serde_json::to_string(&terms) {
        Ok(json) => format!("&keyterms_prompt={}", urlencode(&json)),
        // Serializing a Vec<String> cannot realistically fail; if it somehow
        // does, stream without biasing rather than with a malformed URL.
        Err(_) => String::new(),
    }
}

#[derive(Deserialize, Default)]
struct AaiWord {
    #[serde(default)]
    start: u64,
    #[serde(default)]
    end: u64,
}

#[derive(Deserialize, Default)]
struct AaiMessage {
    #[serde(rename = "type", default)]
    msg_type: String,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    end_of_turn: bool,
    #[serde(default)]
    turn_is_formatted: bool,
    #[serde(default)]
    words: Vec<AaiWord>,
    #[serde(default)]
    error: Option<String>,
}

/// Turn one "Turn" message into either a committed segment (settled and
/// punctuated) or the tentative tail for the in-progress turn.
fn apply_turn(builder: &mut SegmentBuilder, m: &AaiMessage) {
    let text = m.transcript.trim();
    if text.is_empty() {
        return;
    }
    let start_ms = m.words.first().map(|w| w.start).unwrap_or(0);
    let end_ms = m.words.last().map(|w| w.end).unwrap_or(start_ms);

    if m.end_of_turn && m.turn_is_formatted {
        // The turn is settled and punctuated → commit it as one segment.
        builder.push_final(text, 0, start_ms, end_ms);
        builder.emit_committed();
        builder.endpoint();
        builder.emit_tail("", 0, end_ms); // clear the tail
    } else {
        // Cumulative interim hypothesis for the in-progress turn.
        builder.emit_tail(text, 0, start_ms);
    }
}

/// Parse server frames into transcript segments until the socket ends or an
/// in-band error arrives.
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
) -> Result<()> {
    let mut builder = SegmentBuilder::to_frontend(app, source, timeline);
    ws::read_frames("assemblyai", source, read, OnClose::Stop, |payload| {
        on_payload(&mut builder, source, payload)
    })
    .await
}

/// Fold one server payload into `builder`; an in-band error ends the session.
fn on_payload(builder: &mut SegmentBuilder, source: &str, payload: &str) -> Result<Next> {
    let m: AaiMessage = match serde_json::from_str(payload) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[assemblyai:{source}] parse error: {e}");
            return Ok(Next::Continue);
        }
    };
    if let Some(err) = m.error {
        // In-band errors are terminal (the server closes after) — the
        // session is dead, so surface it (see run_metered_session).
        eprintln!("[assemblyai:{source}] error: {err}");
        return Err(anyhow!("server error: {err}"));
    }
    // Everything that isn't a Turn (Begin, Termination, …) is ignored.
    if m.msg_type == "Turn" {
        apply_turn(builder, &m);
    }
    Ok(Next::Continue)
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let url = format!(
        "{AAI_BASE}?sample_rate={}&encoding=pcm_s16le&format_turns=true{}",
        TARGET_SAMPLE_RATE,
        keyterms_param(&config.vocabulary)
    );
    // AssemblyAI takes the API key directly in the Authorization header.
    let ws = connect_with_headers(&url, &[("Authorization", config.api_key.clone())]).await?;
    let (write, read) = ws.split();
    eprintln!(
        "[assemblyai:{source}] connected (diarization unsupported → speaker 0), leg={}",
        config.leg
    );
    // The URL carries the whole config: the upgrade is the handshake.
    note_connected(&app, source, config.leg, false);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);
    // Raw pcm_s16le on the wire; `Terminate` is v3's goodbye frame.
    let pump = Pump {
        finish: Some("{\"type\":\"Terminate\"}"),
        ..Pump::default()
    };
    let forward = ws::forward_audio(write, meter, pcm_rx, pump, |chunk| {
        Message::Binary(pcm_to_le_bytes(chunk))
    });

    drive_session(
        "assemblyai",
        forward,
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::common::testing::{builder, rows, seg};

    #[test]
    fn turns_become_the_tail_until_formatted() {
        let (mut b, out) = builder("them");
        for payload in [
            r#"{"type":"Begin","id":"s"}"#,
            r#"{"type":"Turn","transcript":"hello","end_of_turn":false,"words":[{"start":100,"end":400}]}"#,
            r#"{"type":"Turn","transcript":"hello world","end_of_turn":true,"turn_is_formatted":false,"words":[{"start":100,"end":400},{"start":400,"end":900}]}"#,
            r#"{"type":"Turn","transcript":" Hello world. ","end_of_turn":true,"turn_is_formatted":true,"words":[{"start":100,"end":400},{"start":400,"end":900}]}"#,
            r#"{"type":"Turn","transcript":"   ","end_of_turn":true,"turn_is_formatted":true}"#,
            r#"{"type":"Termination"}"#,
        ] {
            assert!(matches!(
                on_payload(&mut b, "them", payload).unwrap(),
                Next::Continue
            ));
        }
        assert_eq!(
            rows(&out),
            vec![
                seg("them-tail", 0, "hello", false, 100, 100),
                seg("them-tail", 0, "hello world", false, 100, 100),
                seg("them-0", 0, "Hello world.", true, 100, 900),
                seg("them-0", 0, "Hello world.", true, 100, 900),
                seg("them-tail", 0, "", false, 900, 900),
            ]
        );
    }

    #[test]
    fn an_error_message_ends_the_session() {
        let (mut b, _) = builder("them");
        let err = on_payload(&mut b, "them", r#"{"error":"Invalid API key"}"#).unwrap_err();
        assert_eq!(err.to_string(), "server error: Invalid API key");
    }

    #[test]
    fn keyterms_prompt_is_a_url_encoded_json_array() {
        let vocab = vec!["Parley".to_string(), " Parley ".to_string()];
        // The duplicate is normalized away, so the array carries one term.
        assert_eq!(
            keyterms_param(&vocab),
            "&keyterms_prompt=%5B%22Parley%22%5D"
        );
    }

    #[test]
    fn an_empty_dictionary_leaves_the_url_untouched() {
        assert_eq!(keyterms_param(&[]), "");
        assert_eq!(keyterms_param(&["  ".to_string()]), "");
    }
}
