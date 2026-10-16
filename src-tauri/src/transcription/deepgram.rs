//! Deepgram realtime adapter. Streams linear16 PCM over a WebSocket and parses
//! Deepgram's `Results` messages (with optional word-level diarization).

use anyhow::Result;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::batch::{
    group_words, guess_audio_mime, last_end, read_json, BatchRequest, BatchWord,
    TranscriptionResult,
};
use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, note_connected, urlencode, LevelMeter,
    SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT,
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
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
) -> Result<()> {
    let mut builder = SegmentBuilder::to_frontend(app, source, timeline);
    ws::read_frames(
        "deepgram",
        source,
        read,
        OnClose::FailIfAbnormal,
        |payload| on_payload(&mut builder, source, payload),
    )
    .await
}

/// Fold one server payload into `builder`. Deepgram has no in-band errors,
/// so every payload continues the stream; an unparseable one is skipped.
fn on_payload(builder: &mut SegmentBuilder, source: &str, payload: &str) -> Result<Next> {
    match serde_json::from_str::<DgResponse>(payload) {
        Ok(resp) => apply_response(builder, resp),
        Err(e) => eprintln!("[deepgram:{source}] parse error: {e}"),
    }
    Ok(Next::Continue)
}

// --- Batch (pre-recorded) ------------------------------------------------------

const DEEPGRAM_BATCH_BASE: &str = "https://api.deepgram.com";
/// The pre-recorded path pins its model.
const BATCH_MODEL: &str = "nova-3";

#[derive(Deserialize, Default)]
struct BatchResponse {
    #[serde(default)]
    metadata: BatchMeta,
    #[serde(default)]
    results: BatchResults,
}
#[derive(Deserialize, Default)]
struct BatchMeta {
    #[serde(default)]
    duration: f64,
}
#[derive(Deserialize, Default)]
struct BatchResults {
    #[serde(default)]
    channels: Vec<BatchChannel>,
}
#[derive(Deserialize, Default)]
struct BatchChannel {
    #[serde(default)]
    alternatives: Vec<BatchAlternative>,
}
#[derive(Deserialize, Default)]
struct BatchAlternative {
    #[serde(default)]
    words: Vec<DgWord>,
}

/// The pre-recorded `/v1/listen` URL: the pinned model, diarization, the
/// language (or auto-detection) and the custom vocabulary.
fn batch_url(
    base: &str,
    language_hints: &[String],
    diarization: bool,
    vocabulary: &[String],
) -> String {
    let mut url = format!(
        "{base}/v1/listen?model={BATCH_MODEL}&smart_format=true&punctuate=true&diarize={diarization}"
    );
    // One language hint pins the language; otherwise let Deepgram auto-detect.
    match language_hints.first() {
        Some(lang) => url.push_str(&format!("&language={lang}")),
        None => url.push_str("&detect_language=true"),
    }
    // Same keyterm/keywords split as the realtime adapter, keyed off the model
    // this path pins.
    url.push_str(&vocabulary_params(BATCH_MODEL, vocabulary));
    url
}

/// Deepgram pre-recorded API: POST the raw (compressed) bytes to /v1/listen and
/// group the returned diarized word stream. Shape verified vs docs, not live-tested.
pub(crate) async fn transcribe_file(req: BatchRequest<'_>) -> Result<TranscriptionResult, String> {
    let url = batch_url(
        req.base_or(DEEPGRAM_BATCH_BASE),
        req.language_hints,
        req.diarization,
        req.vocabulary,
    );
    let resp = req
        .client
        .post(url)
        .header("Authorization", format!("Token {}", req.credential))
        .header("Content-Type", guess_audio_mime(req.upload_path))
        .body(req.audio)
        .send()
        .await
        .map_err(|e| format!("Deepgram request failed: {e}"))?;
    let dg: BatchResponse = read_json(resp, "deepgram transcribe").await?;
    let words: Vec<BatchWord> = dg
        .results
        .channels
        .first()
        .and_then(|c| c.alternatives.first())
        .map(|a| a.words.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|w| BatchWord {
            speaker: w.speaker,
            text: w.punctuated_word.clone().unwrap_or_else(|| w.word.clone()),
            start_ms: (w.start * 1000.0) as u64,
            end_ms: (w.end * 1000.0) as u64,
        })
        .collect();
    let segments = group_words(&words);
    let duration_ms = ((dg.metadata.duration * 1000.0) as u64).max(last_end(&segments));
    Ok(TranscriptionResult::fresh(segments, duration_ms))
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
        "[deepgram:{source}] connected, model={model}, diarization={}, leg={}",
        config.diarization, config.leg
    );
    // Deepgram takes its whole config in the URL: the upgrade is the handshake.
    note_connected(&app, source, config.leg, false);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);

    drive_session(
        "deepgram",
        forward_audio(write, meter, pcm_rx),
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::common::testing::{builder, rows, seg};

    #[test]
    fn results_become_runs_interims_become_the_tail() {
        let (mut b, out) = builder("me");
        for payload in [
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[
                {"transcript":"hello wor","words":[{"word":"hello","start":0.125,"end":0.5,"speaker":0}]}
            ]}}"#,
            r#"{"type":"Results","is_final":true,"speech_final":false,"channel":{"alternatives":[
                {"transcript":"Hello world.","words":[
                    {"word":"hello","punctuated_word":"Hello","start":0.125,"end":0.5,"speaker":0},
                    {"word":"world","punctuated_word":"world.","start":0.5,"end":1.0,"speaker":0}
                ]}
            ]}}"#,
            r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[
                {"transcript":"Hi","words":[{"word":"hi","punctuated_word":"Hi","start":1.25,"end":1.5,"speaker":1}]}
            ]}}"#,
            r#"{"type":"Metadata","request_id":"x"}"#,
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"  "}]}}"#,
            "not json",
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"so"}]}}"#,
        ] {
            assert!(matches!(
                on_payload(&mut b, "me", payload).unwrap(),
                Next::Continue
            ));
        }
        assert_eq!(
            rows(&out),
            vec![
                seg("me-tail", 0, "hello wor", false, 125, 125),
                seg("me-0", 0, "Hello world. ", true, 125, 1000),
                seg("me-tail", 0, "", false, 1000, 1000),
                // The speaker change commits run 0; speech_final commits run 1.
                seg("me-0", 0, "Hello world. ", true, 125, 1000),
                seg("me-1", 1, "Hi ", true, 1250, 1500),
                seg("me-1", 1, "Hi ", true, 1250, 1500),
                seg("me-tail", 0, "", false, 1500, 1500),
                // A word-less interim keeps the builder's speaker and end.
                seg("me-tail", 0, "so", false, 1500, 1500),
            ]
        );
    }

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
