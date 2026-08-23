//! Deepgram realtime adapter. Streams linear16 PCM over a WebSocket and parses
//! Deepgram's `Results` messages (with optional word-level diarization).

use anyhow::Result;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, urlencode, LevelMeter, SegmentBuilder,
    TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const DEEPGRAM_BASE: &str = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL: &str = "nova-3";

/// Deepgram's custom-vocabulary query params, as a string ready to append to a
/// `/v1/listen` URL (each term gets its OWN param — the API takes them repeated,
/// not comma-joined). Which param depends on the model generation: nova-3 and
/// newer take `keyterm` (Keyterm Prompting); everything older only understands
/// the legacy `keywords`. Empty string when there is nothing to bias toward, so
/// a URL built without a dictionary is unchanged.
///
/// Shared with the batch path in replay.rs so both requests bias identically.
pub fn vocabulary_params(model: &str, vocabulary: &[String]) -> String {
    let param = if model.trim().starts_with("nova-3") {
        "keyterm"
    } else {
        "keywords"
    };
    clean_vocabulary(vocabulary)
        .iter()
        .map(|term| format!("&{param}={}", urlencode(term)))
        .collect()
}

#[derive(Deserialize, Default)]
struct DgWord {
    #[serde(default)]
    word: String,
    #[serde(default)]
    punctuated_word: Option<String>,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    speaker: Option<i64>,
}

#[derive(Deserialize, Default)]
struct DgAlternative {
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    words: Vec<DgWord>,
}

#[derive(Deserialize, Default)]
struct DgChannel {
    #[serde(default)]
    alternatives: Vec<DgAlternative>,
}

#[derive(Deserialize, Default)]
struct DgResponse {
    #[serde(rename = "type", default)]
    msg_type: String,
    #[serde(default)]
    channel: DgChannel,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speech_final: bool,
}

/// The `/v1/listen` URL for this session: fixed stream shape plus the optional
/// diarization, language and custom-vocabulary knobs.
fn listen_url(config: &TranscribeConfig, model: &str) -> String {
    let mut url = format!(
        "{DEEPGRAM_BASE}?encoding=linear16&sample_rate={}&channels=1&interim_results=true&punctuate=true&smart_format=true&model={model}",
        TARGET_SAMPLE_RATE
    );
    if config.diarization {
        url.push_str("&diarize=true");
    }
    if let Some(lang) = config.language_hints.first() {
        url.push_str(&format!("&language={lang}"));
    }
    url.push_str(&vocabulary_params(model, &config.vocabulary));
    url
}

/// Forward PCM as binary frames; keep alive; close cleanly.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> bool {
    let pump = Pump {
        keepalive: Some((
            std::time::Duration::from_secs(5),
            "{\"type\":\"KeepAlive\"}",
        )),
        finish: Some("{\"type\":\"CloseStream\"}"),
        close: true,
    };
    ws::forward_audio(write, meter, pcm_rx, pump, |chunk| {
        Message::Binary(pcm_to_le_bytes(chunk))
    })
    .await
}

/// Settled words → push each into its speaker-run, then commit.
fn commit_final(builder: &mut SegmentBuilder, alt: &DgAlternative, speech_final: bool) {
    for w in &alt.words {
        let text = w.punctuated_word.as_deref().unwrap_or(&w.word);
        if text.is_empty() {
            continue;
        }
        let speaker = w.speaker.unwrap_or(0);
        let start_ms = (w.start * 1000.0) as u64;
        let end_ms = (w.end * 1000.0) as u64;
        builder.push_final(&format!("{text} "), speaker, start_ms, end_ms);
    }
    builder.emit_committed();
    // speech_final marks an utterance boundary.
    if speech_final {
        builder.endpoint();
    }
    // Clear any stale tail now that this chunk is committed.
    builder.emit_tail("", builder.current_speaker(), builder.current_end());
}

/// Interim hypothesis → tentative tail, carrying the builder's current speaker
/// and end time whenever the hypothesis doesn't name its own.
fn emit_interim(builder: &mut SegmentBuilder, alt: &DgAlternative) {
    let speaker = alt
        .words
        .first()
        .and_then(|w| w.speaker)
        .unwrap_or(builder.current_speaker());
    let start_ms = alt
        .words
        .first()
        .map(|w| (w.start * 1000.0) as u64)
        .unwrap_or(builder.current_end());
    builder.emit_tail(&alt.transcript, speaker, start_ms);
}

/// Fold one `Results` message into the segment builder.
fn apply_response(builder: &mut SegmentBuilder, resp: DgResponse) {
    if resp.msg_type != "Results" {
        return; // Metadata, SpeechStarted, UtteranceEnd, etc.
    }
    let Some(alt) = resp.channel.alternatives.into_iter().next() else {
        return;
    };
    if resp.is_final {
        commit_final(builder, &alt, resp.speech_final);
    } else if !alt.transcript.trim().is_empty() {
        emit_interim(builder, &alt);
    }
}

/// Parse server frames into transcript segments until the socket ends.
///
/// Deepgram has no in-band error messages — terminal errors arrive as an
/// abnormal close code (1008 DATA-*, 1011 NET-*, …) whose reason is the only
/// diagnostic we get. A normal close (1000) follows our CloseStream.
async fn read_transcripts(app: AppHandle, source: &'static str, read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    ws::read_frames(
        "deepgram",
        source,
        read,
        OnClose::FailIfAbnormal,
        |payload| {
            match serde_json::from_str::<DgResponse>(payload) {
                Ok(resp) => apply_response(&mut builder, resp),
                Err(e) => eprintln!("[deepgram:{source}] parse error: {e}"),
            }
            Ok(Next::Continue)
        },
    )
    .await
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let url = listen_url(&config, model);

    let ws = connect_with_headers(
        &url,
        &[("Authorization", format!("Token {}", config.api_key))],
    )
    .await?;
    let (write, read) = ws.split();
    eprintln!(
        "[deepgram:{source}] connected, model={model}, diarization={}",
        config.diarization
    );

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);

    drive_session(
        "deepgram",
        forward_audio(write, meter, pcm_rx),
        read_transcripts(app, source, read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nova_3_gets_keyterm_and_older_models_get_keywords() {
        let vocab = vec!["Parley".to_string(), "派勒".to_string()];
        assert_eq!(
            vocabulary_params("nova-3", &vocab),
            "&keyterm=Parley&keyterm=%E6%B4%BE%E5%8B%92"
        );
        assert_eq!(
            vocabulary_params("nova-3-medical", &vocab),
            "&keyterm=Parley&keyterm=%E6%B4%BE%E5%8B%92"
        );
        assert_eq!(
            vocabulary_params("nova-2", &vocab),
            "&keywords=Parley&keywords=%E6%B4%BE%E5%8B%92"
        );
    }

    #[test]
    fn an_empty_dictionary_leaves_the_url_untouched() {
        assert_eq!(vocabulary_params("nova-3", &[]), "");
        assert_eq!(vocabulary_params("nova-3", &["   ".to_string()]), "");
    }
}
