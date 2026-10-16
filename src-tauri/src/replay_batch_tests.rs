//! Characterization tests for the batch (upload) adapters: each one runs
//! against a local scripted server returning responses shaped like the
//! vendor's, and the tests pin down the requests it sends, the segments it
//! builds, how it polls, and the error text it fails with.

use super::*;
use crate::test_http::{serve, upload_file, MockServer};
use serde_json::{json, Value};

const AUDIO: &[u8] = b"OggS-fake-audio-bytes";

fn fast_poll(max_polls: u32) -> PollPolicy {
    PollPolicy {
        interval: Duration::from_millis(1),
        max_polls,
    }
}

fn result_json(r: &TranscriptionResult) -> Value {
    serde_json::to_value(r).unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// The soniox log context, owned, as the adapter handed it to the writer.
#[derive(Debug, Default)]
struct SonioxLog {
    model: String,
    diarization: bool,
    language_hints: Vec<String>,
    file_name: String,
    audio_duration_ms: u64,
    token_count: usize,
    tokens_with_speaker: usize,
    distinct_speakers: Vec<i64>,
    raw_transcript: String,
}

// --- Soniox ------------------------------------------------------------------

const SONIOX_TRANSCRIPT: &str = r#"{"tokens":[
    {"text":"Hello","start_ms":0,"end_ms":300,"speaker":"1"},
    {"text":" world","start_ms":300,"end_ms":600,"speaker":1},
    {"text":"<end>"},
    {"text":" Hi","start_ms":700,"end_ms":900,"speaker":"2"},
    {"text":".","start_ms":900,"end_ms":910}
]}"#;

async fn soniox_server(poll: Vec<(u16, &str)>) -> MockServer {
    serve(vec![
        ("POST /v1/files", vec![(200, r#"{"id":"file-1"}"#)]),
        ("POST /v1/transcriptions", vec![(200, r#"{"id":"tr-1"}"#)]),
        ("GET /v1/transcriptions/tr-1", poll),
        (
            "GET /v1/transcriptions/tr-1/transcript",
            vec![(200, SONIOX_TRANSCRIPT)],
        ),
        ("DELETE /v1/transcriptions/tr-1", vec![(204, "")]),
        ("DELETE /v1/files/file-1", vec![(204, "")]),
    ])
    .await
}

async fn run_soniox(
    server: &MockServer,
    poll: PollPolicy,
    hints: &[&str],
    vocabulary: &[&str],
) -> (Result<TranscriptionResult, String>, Option<SonioxLog>) {
    let path = upload_file("rec.ogg", AUDIO);
    let mut log = None;
    let result = run_upload_and_transcribe(
        &reqwest::Client::new(),
        &format!("{}/v1", server.base),
        poll,
        "sk-test",
        path.to_str().unwrap(),
        DEFAULT_ASYNC_MODEL,
        &strings(hints),
        true,
        &strings(vocabulary),
        |ctx| {
            log = Some(SonioxLog {
                model: ctx.model.to_string(),
                diarization: ctx.enable_speaker_diarization,
                language_hints: ctx.language_hints.to_vec(),
                file_name: ctx.file_name.to_string(),
                audio_duration_ms: ctx.audio_duration_ms,
                token_count: ctx.token_count,
                tokens_with_speaker: ctx.tokens_with_speaker,
                distinct_speakers: ctx.distinct_speakers.iter().copied().collect(),
                raw_transcript: ctx.raw_transcript.to_string(),
            })
        },
    )
    .await;
    (result, log)
}

#[tokio::test]
async fn soniox_uploads_creates_polls_fetches_and_cleans_up() {
    let server = soniox_server(vec![
        (200, r#"{"status":"queued"}"#),
        (200, r#"{"status":"completed","audio_duration_ms":5000}"#),
    ])
    .await;
    let (result, log) = run_soniox(&server, fast_poll(5), &["zh", "en"], &[" Parley ", ""]).await;

    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 1, "text": "Hello world", "startMs": 0, "endMs": 600},
                {"id": "them-1", "speaker": 2, "text": " Hi.", "startMs": 700, "endMs": 910},
            ],
            "durationMs": 5000,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    assert_eq!(
        server.trace(),
        vec![
            "POST /v1/files",
            "POST /v1/transcriptions",
            "GET /v1/transcriptions/tr-1",
            "GET /v1/transcriptions/tr-1",
            "GET /v1/transcriptions/tr-1/transcript",
            "DELETE /v1/transcriptions/tr-1",
            "DELETE /v1/files/file-1",
        ]
    );
    for r in server.requests() {
        assert_eq!(
            r.header("authorization"),
            Some("Bearer sk-test"),
            "{}",
            r.path
        );
    }
    let upload = &server.requests_to("POST", "/v1/files")[0];
    assert!(upload
        .header("content-type")
        .unwrap()
        .starts_with("multipart/form-data"));
    let form = upload.body_text();
    assert!(
        form.contains(r#"name="file"; filename="rec.ogg""#),
        "{form}"
    );
    assert!(form.contains("OggS-fake-audio-bytes"));
    assert_eq!(
        server.requests_to("POST", "/v1/transcriptions")[0].body_json(),
        json!({
            "file_id": "file-1",
            "model": "stt-async-v5",
            "language_hints": ["zh", "en"],
            "enable_speaker_diarization": true,
            "context": {"terms": ["Parley"]},
        })
    );

    let log = log.expect("the diagnostic log is written");
    assert_eq!(log.model, "stt-async-v5");
    assert!(log.diarization);
    assert_eq!(log.language_hints, strings(&["zh", "en"]));
    assert_eq!(log.file_name, "rec.ogg");
    assert_eq!(log.audio_duration_ms, 5000);
    assert_eq!(log.token_count, 5);
    assert_eq!(log.tokens_with_speaker, 3);
    assert_eq!(log.distinct_speakers, vec![1, 2]);
    assert_eq!(log.raw_transcript, SONIOX_TRANSCRIPT);
}

#[tokio::test]
async fn soniox_omits_empty_hints_and_context() {
    let server = soniox_server(vec![(200, r#"{"status":"completed"}"#)]).await;
    let (result, _) = run_soniox(&server, fast_poll(5), &[], &["  "]).await;
    // No reported duration: the last segment's end is the duration.
    assert_eq!(result.unwrap().duration_ms, 910);
    assert_eq!(
        server.requests_to("POST", "/v1/transcriptions")[0].body_json(),
        json!({
            "file_id": "file-1",
            "model": "stt-async-v5",
            "enable_speaker_diarization": true,
        })
    );
}

#[tokio::test]
async fn soniox_surfaces_http_errors_with_status_and_body() {
    let server = serve(vec![(
        "POST /v1/files",
        vec![(401, r#"{"error":"bad key"}"#)],
    )])
    .await;
    let (result, log) = run_soniox(&server, fast_poll(5), &[], &[]).await;
    assert_eq!(
        result.unwrap_err(),
        r#"file upload: HTTP 401 Unauthorized: {"error":"bad key"}"#
    );
    assert!(log.is_none());
}

#[tokio::test]
async fn soniox_reports_unparseable_json_with_the_body() {
    let server = serve(vec![("POST /v1/files", vec![(200, "not json")])]).await;
    let (result, _) = run_soniox(&server, fast_poll(5), &[], &[]).await;
    let err = result.unwrap_err();
    assert!(err.starts_with("file upload: bad response JSON: "), "{err}");
    assert!(err.ends_with(" — not json"), "{err}");
}

#[tokio::test]
async fn soniox_fails_a_job_the_provider_failed() {
    let server = soniox_server(vec![(200, r#"{"status":"error","error_message":"boom"}"#)]).await;
    let (result, _) = run_soniox(&server, fast_poll(5), &[], &[]).await;
    assert_eq!(result.unwrap_err(), "Transcription failed: boom");
    let server = soniox_server(vec![(200, r#"{"status":"error"}"#)]).await;
    let (result, _) = run_soniox(&server, fast_poll(5), &[], &[]).await;
    assert_eq!(result.unwrap_err(), "Transcription failed: unknown error");
}

#[tokio::test]
async fn soniox_gives_up_after_the_poll_cap() {
    let server = soniox_server(vec![(200, r#"{"status":"processing"}"#)]).await;
    let (result, _) = run_soniox(&server, fast_poll(3), &[], &[]).await;
    assert_eq!(result.unwrap_err(), "Transcription timed out");
    assert_eq!(
        server.requests_to("GET", "/v1/transcriptions/tr-1").len(),
        3
    );
}

// --- Deepgram ----------------------------------------------------------------

const DEEPGRAM_RESPONSE: &str = r#"{
    "metadata": {"duration": 2.5},
    "results": {"channels": [{"alternatives": [{"words": [
        {"word": "hello", "punctuated_word": "Hello", "start": 0.0, "end": 0.4, "speaker": 0},
        {"word": "there", "start": 0.4, "end": 0.8, "speaker": 0},
        {"word": "hi", "punctuated_word": "Hi.", "start": 1.0, "end": 1.3, "speaker": 1},
        {"word": "ok", "start": 1.3, "end": 1.5}
    ]}]}]}
}"#;

async fn run_deepgram(
    server: &MockServer,
    hints: &[&str],
    diarization: bool,
    vocabulary: &[&str],
) -> Result<TranscriptionResult, String> {
    let path = upload_file("rec.ogg", AUDIO);
    deepgram_batch(
        &reqwest::Client::new(),
        &server.base,
        "dg-key",
        path.to_str().unwrap(),
        &strings(hints),
        diarization,
        &strings(vocabulary),
    )
    .await
}

#[tokio::test]
async fn deepgram_posts_the_bytes_and_groups_the_diarized_words() {
    let server = serve(vec![("POST /v1/listen", vec![(200, DEEPGRAM_RESPONSE)])]).await;
    let result = run_deepgram(&server, &["zh", "en"], true, &["Parley", "派斯"]).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "Hello there", "startMs": 0, "endMs": 800},
                {"id": "them-1", "speaker": 1, "text": "Hi. ok", "startMs": 1000, "endMs": 1500},
            ],
            "durationMs": 2500,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    let req = &server.requests_to("POST", "/v1/listen")[0];
    assert_eq!(
        req.query,
        "model=nova-3&smart_format=true&punctuate=true&diarize=true&language=zh&keyterm=Parley&keyterm=%E6%B4%BE%E6%96%AF"
    );
    assert_eq!(req.header("authorization"), Some("Token dg-key"));
    assert_eq!(req.header("content-type"), Some("audio/ogg"));
    assert_eq!(req.body, AUDIO);
}

#[tokio::test]
async fn deepgram_auto_detects_without_a_hint() {
    let server = serve(vec![("POST /v1/listen", vec![(200, "{}")])]).await;
    let result = run_deepgram(&server, &[], false, &[]).await.unwrap();
    assert!(result.segments.is_empty());
    assert_eq!(result.duration_ms, 0);
    assert_eq!(
        server.requests()[0].query,
        "model=nova-3&smart_format=true&punctuate=true&diarize=false&detect_language=true"
    );
}

#[tokio::test]
async fn deepgram_surfaces_http_errors() {
    let server = serve(vec![("POST /v1/listen", vec![(403, "nope")])]).await;
    assert_eq!(
        run_deepgram(&server, &[], true, &[]).await.unwrap_err(),
        "deepgram transcribe: HTTP 403 Forbidden: nope"
    );
}

// --- AssemblyAI --------------------------------------------------------------

const AAI_DONE: &str = r#"{"id":"t1","status":"completed","audio_duration":3.2,"utterances":[
    {"speaker":"A","text":" Hello ","start":0,"end":500},
    {"speaker":"B","text":"  ","start":500,"end":600},
    {"speaker":"B","text":"Hi","start":600,"end":900}
]}"#;

async fn aai_server(create: &str, poll: Vec<(u16, &str)>) -> MockServer {
    serve(vec![
        (
            "POST /v2/upload",
            vec![(200, r#"{"upload_url":"https://cdn.example/u1"}"#)],
        ),
        ("POST /v2/transcript", vec![(200, create)]),
        ("GET /v2/transcript/t1", poll),
    ])
    .await
}

async fn run_aai(
    server: &MockServer,
    poll: PollPolicy,
    hints: &[&str],
    vocabulary: &[&str],
) -> Result<TranscriptionResult, String> {
    let path = upload_file("rec.ogg", AUDIO);
    assemblyai_batch(
        &reqwest::Client::new(),
        &server.base,
        poll,
        "aai-key",
        path.to_str().unwrap(),
        &strings(hints),
        true,
        &strings(vocabulary),
    )
    .await
}

#[tokio::test]
async fn assemblyai_uploads_creates_polls_and_maps_utterances() {
    let server = aai_server(
        r#"{"id":"t1","status":"queued"}"#,
        vec![
            (200, r#"{"id":"t1","status":"processing"}"#),
            (200, AAI_DONE),
        ],
    )
    .await;
    let result = run_aai(&server, fast_poll(5), &["zh"], &["Parley", "Parley "]).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "Hello", "startMs": 0, "endMs": 500},
                {"id": "them-1", "speaker": 1, "text": "Hi", "startMs": 600, "endMs": 900},
            ],
            "durationMs": 3200,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    assert_eq!(
        server.trace(),
        vec![
            "POST /v2/upload",
            "POST /v2/transcript",
            "GET /v2/transcript/t1",
            "GET /v2/transcript/t1",
        ]
    );
    for r in server.requests() {
        assert_eq!(r.header("authorization"), Some("aai-key"), "{}", r.path);
    }
    let upload = &server.requests_to("POST", "/v2/upload")[0];
    assert_eq!(
        upload.header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(upload.body, AUDIO);
    assert_eq!(
        server.requests_to("POST", "/v2/transcript")[0].body_json(),
        json!({
            "audio_url": "https://cdn.example/u1",
            "speaker_labels": true,
            "language_code": "zh",
            "word_boost": ["Parley"],
        })
    );
}

#[tokio::test]
async fn assemblyai_detects_the_language_and_falls_back_to_the_flat_text() {
    let server = aai_server(
        r#"{"id":"t1"}"#,
        vec![(
            200,
            r#"{"status":"completed","audio_duration":2.0,"text":" all of it ","utterances":[]}"#,
        )],
    )
    .await;
    let result = run_aai(&server, fast_poll(5), &[], &[]).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "all of it", "startMs": 0, "endMs": 2000},
            ],
            "durationMs": 2000,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    assert_eq!(
        server.requests_to("POST", "/v2/transcript")[0].body_json(),
        json!({
            "audio_url": "https://cdn.example/u1",
            "speaker_labels": true,
            "language_detection": true,
        })
    );
}

#[tokio::test]
async fn assemblyai_failures() {
    let server = aai_server(r#"{"status":"queued"}"#, vec![]).await;
    assert_eq!(
        run_aai(&server, fast_poll(5), &[], &[]).await.unwrap_err(),
        "AssemblyAI: no transcript id returned"
    );
    let server = aai_server(
        r#"{"id":"t1"}"#,
        vec![(200, r#"{"status":"error","error":"bad audio"}"#)],
    )
    .await;
    assert_eq!(
        run_aai(&server, fast_poll(5), &[], &[]).await.unwrap_err(),
        "AssemblyAI transcription failed: bad audio"
    );
    let server = aai_server(r#"{"id":"t1"}"#, vec![(200, r#"{"status":"error"}"#)]).await;
    assert_eq!(
        run_aai(&server, fast_poll(5), &[], &[]).await.unwrap_err(),
        "AssemblyAI transcription failed: unknown error"
    );
    let server = aai_server(r#"{"id":"t1"}"#, vec![(200, r#"{"status":"queued"}"#)]).await;
    assert_eq!(
        run_aai(&server, fast_poll(4), &[], &[]).await.unwrap_err(),
        "AssemblyAI transcription timed out"
    );
    assert_eq!(server.requests_to("GET", "/v2/transcript/t1").len(), 4);
    let server = serve(vec![("POST /v2/upload", vec![(401, "Invalid API key")])]).await;
    assert_eq!(
        run_aai(&server, fast_poll(4), &[], &[]).await.unwrap_err(),
        "assemblyai upload: HTTP 401 Unauthorized: Invalid API key"
    );
}

// --- OpenAI ------------------------------------------------------------------

async fn run_openai(
    server: &MockServer,
    model: Option<&str>,
    hints: &[&str],
    vocabulary: &[&str],
) -> Result<TranscriptionResult, String> {
    let path = upload_file("rec.ogg", AUDIO);
    openai_batch(
        &reqwest::Client::new(),
        &server.base,
        "oa-key",
        path.to_str().unwrap(),
        model,
        &strings(hints),
        &strings(vocabulary),
    )
    .await
}

#[tokio::test]
async fn openai_sends_a_verbose_json_form_and_maps_the_segments() {
    let server = serve(vec![(
        "POST /v1/audio/transcriptions",
        vec![(
            200,
            r#"{"duration":4.2,"text":"Hello there","segments":[
                {"start":0.0,"end":1.5,"text":" Hello "},
                {"start":1.5,"end":2.0,"text":" "},
                {"start":2.0,"end":3.0,"text":"there"}
            ]}"#,
        )],
    )])
    .await;
    let result = run_openai(&server, None, &["zh", "en"], &["Parley", "派斯"]).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "Hello", "startMs": 0, "endMs": 1500},
                {"id": "them-1", "speaker": 0, "text": "there", "startMs": 2000, "endMs": 3000},
            ],
            "durationMs": 4200,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    let req = &server.requests()[0];
    assert_eq!(req.header("authorization"), Some("Bearer oa-key"));
    let form = req.body_text();
    for part in [
        "name=\"file\"; filename=\"rec.ogg\"\r\nContent-Type: audio/ogg",
        "name=\"model\"\r\n\r\nwhisper-1\r\n",
        "name=\"response_format\"\r\n\r\nverbose_json\r\n",
        "name=\"language\"\r\n\r\nzh\r\n",
        "name=\"prompt\"\r\n\r\nParley, 派斯\r\n",
    ] {
        assert!(form.contains(part), "missing {part:?} in {form}");
    }
}

#[tokio::test]
async fn openai_honours_the_model_and_falls_back_to_the_flat_text() {
    let server = serve(vec![(
        "POST /v1/audio/transcriptions",
        vec![(
            200,
            r#"{"duration":1.0,"text":" whole thing ","segments":[]}"#,
        )],
    )])
    .await;
    let result = run_openai(&server, Some("gpt-x"), &[], &[]).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "whole thing", "startMs": 0, "endMs": 1000},
            ],
            "durationMs": 1000,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    let form = server.requests()[0].body_text();
    assert!(form.contains("name=\"model\"\r\n\r\ngpt-x\r\n"));
    assert!(!form.contains("name=\"language\""));
    assert!(!form.contains("name=\"prompt\""));
}

#[tokio::test]
async fn openai_surfaces_http_errors() {
    let server = serve(vec![(
        "POST /v1/audio/transcriptions",
        vec![(400, r#"{"error":{"message":"bad"}}"#)],
    )])
    .await;
    assert_eq!(
        run_openai(&server, None, &[], &[]).await.unwrap_err(),
        r#"openai transcribe: HTTP 400 Bad Request: {"error":{"message":"bad"}}"#
    );
}

// --- Gemini ------------------------------------------------------------------

async fn run_gemini(
    server: &MockServer,
    model: Option<&str>,
    vocabulary: &[&str],
) -> Result<TranscriptionResult, String> {
    let path = upload_file("rec.ogg", AUDIO);
    gemini_batch(
        &reqwest::Client::new(),
        &server.base,
        "gm-key",
        path.to_str().unwrap(),
        model,
        &[],
        &strings(vocabulary),
    )
    .await
}

#[tokio::test]
async fn gemini_inlines_the_audio_and_returns_one_segment() {
    use base64::Engine as _;
    let server = serve(vec![(
        "POST /v1beta/models/gemini-2.5-flash:generateContent",
        vec![(
            200,
            r#"{"candidates":[{"content":{"parts":[{"text":"  Hello world  "}]}}]}"#,
        )],
    )])
    .await;
    let result = run_gemini(&server, None, &["Parley"]).await;
    // The fake audio cannot be decoded, so its length reads as 0.
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 0, "text": "Hello world", "startMs": 0, "endMs": 0},
            ],
            "durationMs": 0,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    let req = &server.requests()[0];
    assert_eq!(req.query, "key=gm-key");
    assert_eq!(
        req.body_json(),
        json!({
            "contents": [{
                "parts": [
                    {"inline_data": {
                        "mime_type": "audio/ogg",
                        "data": base64::engine::general_purpose::STANDARD.encode(AUDIO),
                    }},
                    {"text": "Transcribe this audio verbatim. Output only the transcript text, with no commentary, labels, or timestamps.\nDomain terms that may occur — spell them exactly as written: Parley."},
                ]
            }]
        })
    );
}

#[tokio::test]
async fn gemini_honours_the_model_and_tolerates_an_empty_answer() {
    let server = serve(vec![(
        "POST /v1beta/models/gemini-x:generateContent",
        vec![(200, "{}")],
    )])
    .await;
    let result = run_gemini(&server, Some("gemini-x"), &[]).await.unwrap();
    assert!(result.segments.is_empty());
    let body = server.requests()[0].body_json();
    assert_eq!(
        body["contents"][0]["parts"][1]["text"],
        json!("Transcribe this audio verbatim. Output only the transcript text, with no commentary, labels, or timestamps.")
    );
}

// --- Parley Cloud ------------------------------------------------------------

const CLOUD_TRANSCRIPT: &str = r#"{"tokens":[
    {"text":"Hello","start_ms":0,"end_ms":300,"speaker":1},
    {"text":" there","start_ms":300,"end_ms":600,"speaker":1},
    {"text":"你好","start_ms":700,"end_ms":1000,"speaker":2}
]}"#;

async fn cloud_server(
    create: (u16, &str),
    poll: Vec<(u16, &str)>,
    transcript: (u16, &str),
) -> MockServer {
    serve(vec![
        ("POST /stt/batch", vec![create]),
        ("GET /stt/batch/j1", poll),
        ("GET /stt/batch/j1/transcript", vec![transcript]),
        ("DELETE /stt/batch/j1", vec![(204, "")]),
    ])
    .await
}

async fn run_cloud(server: &MockServer, poll: PollPolicy) -> Result<TranscriptionResult, String> {
    let path = upload_file("rec.ogg", AUDIO);
    let languages = strings(&["zh", "en"]);
    let vocabulary = strings(&["Parley"]);
    parley_batch(
        &reqwest::Client::new(),
        poll,
        "cloud-token",
        &format!("{}/stt/batch", server.base),
        path.to_str().unwrap(),
        &BatchOptions {
            languages: &languages,
            diarization: true,
            vocabulary: &vocabulary,
        },
    )
    .await
}

#[tokio::test]
async fn parley_cloud_posts_polls_fetches_and_deletes() {
    let server = cloud_server(
        (200, r#"{"id":"j1"}"#),
        vec![
            (200, r#"{"status":"processing","durationMs":null}"#),
            (200, r#"{"status":"completed","durationMs":4000}"#),
        ],
        (200, CLOUD_TRANSCRIPT),
    )
    .await;
    let result = run_cloud(&server, fast_poll(5)).await;
    assert_eq!(
        result_json(&result.unwrap()),
        json!({
            "segments": [
                {"id": "them-0", "speaker": 1, "text": "Hello there", "startMs": 0, "endMs": 600},
                {"id": "them-1", "speaker": 2, "text": "你好", "startMs": 700, "endMs": 1000},
            ],
            "durationMs": 4000,
            "cached": false,
            "speechRateHz": 0.0,
        })
    );
    assert_eq!(
        server.trace(),
        vec![
            "POST /stt/batch",
            "GET /stt/batch/j1",
            "GET /stt/batch/j1",
            "GET /stt/batch/j1/transcript",
            "DELETE /stt/batch/j1",
        ]
    );
    for r in server.requests() {
        assert_eq!(
            r.header("authorization"),
            Some("Bearer cloud-token"),
            "{}",
            r.path
        );
    }
    let create = &server.requests_to("POST", "/stt/batch")[0];
    assert_eq!(create.query, "diarization=1&languages=zh,en&terms=Parley");
    assert_eq!(
        create.header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(create.body, AUDIO);
    assert_eq!(
        server.requests_to("GET", "/stt/batch/j1/transcript")[0].query,
        "format=parley"
    );
}

#[tokio::test]
async fn parley_cloud_create_failures_name_the_next_step() {
    let cases: &[(u16, &str, &str)] = &[
        (401, "", "Sign in to Parley Cloud to transcribe recordings."),
        (
            402,
            "",
            "Your monthly hosted transcription quota is used up — upgrade your plan or wait for it to reset.",
        ),
        (
            429,
            "",
            "Too many transcriptions running at once — wait for a meeting or an earlier upload to finish, then try again.",
        ),
        (
            413,
            "",
            "This recording is too large for hosted transcription — split it into shorter files and upload them separately.",
        ),
        (
            502,
            "",
            "Parley Cloud couldn't reach the transcription service — try again in a few minutes.",
        ),
        (
            500,
            r#"{"error":"boom"}"#,
            "Hosted transcription failed (HTTP 500 Internal Server Error): boom",
        ),
        (418, "teapot", "Hosted transcription failed (HTTP 418 I'm a teapot)"),
    ];
    for (status, body, expected) in cases {
        let server = cloud_server((*status, body), vec![], (200, "{}")).await;
        assert_eq!(
            run_cloud(&server, fast_poll(5)).await.unwrap_err(),
            *expected,
            "{status}"
        );
        assert_eq!(server.trace(), vec!["POST /stt/batch"]);
    }
}

#[tokio::test]
async fn parley_cloud_job_and_transcript_failures() {
    let server = cloud_server(
        (200, r#"{"id":"j1"}"#),
        vec![(200, r#"{"status":"error","errorMessage":"too quiet"}"#)],
        (200, "{}"),
    )
    .await;
    assert_eq!(
        run_cloud(&server, fast_poll(5)).await.unwrap_err(),
        "Transcription failed: too quiet"
    );
    let server = cloud_server(
        (200, r#"{"id":"j1"}"#),
        vec![(200, r#"{"status":"queued"}"#)],
        (200, "{}"),
    )
    .await;
    assert_eq!(
        run_cloud(&server, fast_poll(2)).await.unwrap_err(),
        "Transcription timed out"
    );
    assert_eq!(server.requests_to("GET", "/stt/batch/j1").len(), 2);
    let server = cloud_server(
        (200, r#"{"id":"j1"}"#),
        vec![(200, r#"{"status":"completed","durationMs":10}"#)],
        (401, ""),
    )
    .await;
    assert_eq!(
        run_cloud(&server, fast_poll(5)).await.unwrap_err(),
        "Sign in to Parley Cloud to transcribe recordings."
    );
    let server = cloud_server(
        (200, r#"{"id":"j1"}"#),
        vec![(200, r#"{"status":"completed","durationMs":10}"#)],
        (200, "garbage"),
    )
    .await;
    let err = run_cloud(&server, fast_poll(5)).await.unwrap_err();
    assert!(err.starts_with("Unreadable hosted transcript: "), "{err}");
}

// --- Entry checks and cache names ---------------------------------------------

#[test]
fn an_upload_without_a_credential_is_refused_unless_on_device() {
    let missing = "Missing transcription credential — add the provider's API key in Settings, or sign in to Parley Cloud.";
    for provider in [
        "soniox",
        "deepgram",
        "assemblyai",
        "openai",
        "gemini",
        "parley",
        "nope",
    ] {
        assert_eq!(
            check_batch_credential(provider, " "),
            Err(missing.to_string()),
            "{provider}"
        );
        assert_eq!(check_batch_credential(provider, "k"), Ok(()));
    }
    assert_eq!(check_batch_credential("local", ""), Ok(()));
}

#[test]
fn hosted_uploads_need_the_batch_url() {
    let missing = Err("hosted transcription requires the cloud batch URL".to_string());
    assert_eq!(hosted_batch_base(None), missing);
    assert_eq!(hosted_batch_base(Some("  ")), missing);
    assert_eq!(
        hosted_batch_base(Some(" https://x/stt/batch ")),
        Ok("https://x/stt/batch")
    );
    assert_eq!(
        unsupported_batch_provider("whisperx"),
        "File transcription for 'whisperx' is not supported yet — switch to another transcription provider in Settings."
    );
}

#[test]
fn cache_file_names_stay_stable() {
    // Existing caches on users' disks are found by exactly these names.
    assert_eq!(cache_file_name("rec.ogg", 42, "soniox"), "rec.ogg-42.json");
    assert_eq!(
        cache_file_name("rec.ogg", 42, "deepgram"),
        "rec.ogg-42-deepgram.json"
    );
    assert_eq!(
        cache_file_name("會議 #1.m4a", 7, "parley"),
        "會議__1.m4a-7-parley.json"
    );
    assert_eq!(
        cache_file_name("a/b.wav", 1, "local-whisper-small-q5_1"),
        "a_b.wav-1-local-whisper-small-q5_1.json"
    );
    assert_eq!(cache_key("soniox", Some("stt-async-v5")), "soniox");
    assert_eq!(cache_key("openai", None), "openai");
    assert_eq!(
        cache_key("local", None),
        format!("local-{}", crate::local_stt::DEFAULT_MODEL_ID)
    );
    assert_eq!(
        cache_key("local", Some("whisper-small-q5_1")),
        "local-whisper-small-q5_1"
    );
}
