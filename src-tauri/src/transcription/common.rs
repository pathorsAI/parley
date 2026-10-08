//! Shared building blocks for transcription adapters.
//!
//! Every provider speaks its own wire protocol, but they all funnel results
//! through the same primitives here: a [`SegmentBuilder`] that groups finalized
//! tokens into speaker-runs and emits `transcript://segment` events, a
//! [`LevelMeter`] that emits `audio://level`, and small connect/emit helpers.
//!
//! Diarization is optional: adapters that can't tell speakers apart simply pass
//! `speaker = 0` for everything, which the UI renders as a single speaker.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::TARGET_SAMPLE_RATE;

/// Event the frontend listens on for meeting transcript updates (see tauriEvents.ts).
pub const TRANSCRIPT_EVENT: &str = "transcript://segment";
/// Event the frontend listens on for the live input-level meter.
pub const LEVEL_EVENT: &str = "audio://level";
/// Event the frontend listens on for live delivery-coaching prosody metrics
/// (pitch variation, pauses) computed on the "me" mic stream — see
/// [`crate::audio::prosody::ProsodyAnalyzer`].
pub const PROSODY_EVENT: &str = "audio://prosody";

/// The `source` label of a voice-typing session's events.
pub const VOICE_TYPING_SOURCE: &str = "voice-typing";

/// Event the frontend listens on for the live transcription's connection
/// state during a meeting. Payloads: `{ source, state: "live", leg }` once a
/// leg's handshake completes (see [`note_connected`]), and `{ source, state:
/// "reconnecting", attempt }` while the session redials after a dropped
/// connection (see `capture::run_metered_session`). The recording itself never
/// depends on either.
pub const TRANSCRIPTION_STATE_EVENT: &str = "meeting://transcription";

/// How long a provider handshake (TCP + TLS + websocket upgrade) may take.
/// A healthy one completes in well under a second, though the hosted relay
/// usually takes about two and has been seen at six and a half; without a
/// bound, a dial into a dead network waits on the OS, which can take minutes —
/// long past the hold buffer that keeps the meeting's words for the next leg,
/// and long past any dictation the user is waiting on.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

tokio::task_local! {
    /// The voice-typing session the current task belongs to, set by
    /// `run_metered_session` for the whole session task and `None` for
    /// meetings.
    pub static SESSION: Option<u64>;

    /// The bridge feeding the current meeting leg, scoped by the session loop
    /// around each leg's `run_session` (see `capture::run_legs`). The adapter
    /// runs inline in that task, so [`note_connected`] can reach it to
    /// [confirm](crate::transcription::bridge::SttBridge::confirm) the
    /// handshake — which is what lets the bridge stop keeping copies of the
    /// audio it fed the leg. Unset for voice typing.
    pub static BRIDGE: Option<std::sync::Arc<crate::transcription::bridge::SttBridge>>;
}

/// The session id to stamp on an event for `source`. A voice-typing event
/// emitted outside its session scope (a task spawned inside an adapter does
/// not inherit it) would be dropped by the overlay, so that is an error here.
pub fn session_for(source: &str) -> Option<u64> {
    let session = SESSION.try_with(|s| *s).ok().flatten();
    if session.is_none() && source == VOICE_TYPING_SOURCE {
        debug_assert!(
            false,
            "voice-typing event emitted outside its session scope"
        );
        log::error!(
            "[stt:{source}] event emitted outside its session scope; the overlay will drop it"
        );
    }
    session
}

/// Emitted once per session when its socket is open and the opening config has
/// gone out: audio captured since the press (buffered while the handshake ran)
/// is on its way to the recognizer from here, so nothing can come back before
/// it. The voice-typing host times its wait for the final answer from the later
/// of this and the release — the hosted relay takes two seconds or more to
/// accept a connection, and a short dictation is often released before that.
/// `acksFinalize`: the provider answers the closing finalize with an explicit
/// end of stream (Soniox's `<fin>`), so the host waits for that close rather
/// than guessing from silence.
pub const CONNECTED_EVENT: &str = "stt://connected";

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
    /// Custom vocabulary — the phrase dictionary's phrases (product names,
    /// jargon, people) biased into recognition so the provider spells them the
    /// way the user does. Every provider expresses this differently (Soniox
    /// `context`, Deepgram `keyterm`/`keywords`, AssemblyAI `keyterms_prompt`,
    /// an OpenAI transcription `prompt`, a Gemini system instruction), so each
    /// adapter maps it onto its own wire field; empty = no biasing at all.
    pub vocabulary: Vec<String>,
    /// Hosted "parley" mode: when set, this is the cloud STT relay's `wss://` URL.
    /// The adapter connects HERE (not the vendor) with `Authorization: Bearer
    /// {api_key}` and omits the provider key from its config frame — the relay
    /// injects the real key server-side, so the vendor stays hidden. `None` =
    /// BYOK direct-to-vendor (the default for every other provider).
    pub relay_endpoint: Option<String>,
    /// Which leg of a reconnecting meeting session this is: 0 for the first
    /// connection, +1 per redial. Every leg numbers its segments from zero, so
    /// leg > 0 namespaces its ids (see [`Timeline::segment_id`]) — otherwise a
    /// reconnect would overwrite the opening of the meeting with its own first
    /// sentence. Always 0 outside meetings.
    pub leg: u32,
    /// Milliseconds into the recording at which this leg's first sample was
    /// captured. A new provider session's clock restarts at zero, so every
    /// timestamp the leg emits is shifted by this to stay on the recording's
    /// timeline. Always 0 for the first leg and outside meetings.
    pub time_offset_ms: u64,
    /// Whether the adapter emits `audio://level` for the audio it sends. A
    /// reconnecting meeting turns it off and meters at its bridge instead:
    /// the bridge sees every chunk as it is captured, while an adapter sees
    /// nothing during a handshake and then the whole hold buffer in one burst
    /// (hundreds of level events in a second — a thrashing titlebar meter).
    pub level_events: bool,
}

impl TranscribeConfig {
    /// The leg/offset pair the segment builder stamps onto what it emits.
    pub fn timeline(&self) -> Timeline {
        Timeline {
            leg: self.leg,
            offset_ms: self.time_offset_ms,
        }
    }
}

/// Where one session leg sits in its meeting: which leg it is (for segment
/// ids) and where its clock starts (for timestamps). Pure, so the id and
/// offset rules are testable without an `AppHandle`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Timeline {
    pub leg: u32,
    pub offset_ms: u64,
}

impl Timeline {
    /// The id of committed segment `index` from `source`. The first leg keeps
    /// the plain `{source}-{index}` shape — the frontend and saved history key
    /// on it — and later legs insert `@{leg}` so their indices, which restart
    /// at zero, can never collide with an earlier leg's.
    pub fn segment_id(&self, source: &str, index: u64) -> String {
        if self.leg == 0 {
            format!("{source}-{index}")
        } else {
            format!("{source}@{}-{index}", self.leg)
        }
    }

    /// A provider timestamp moved onto the recording's timeline.
    pub fn shift(&self, ms: u64) -> u64 {
        ms.saturating_add(self.offset_ms)
    }
}

/// Normalize a custom-vocabulary list before it goes on the wire: trim each
/// term, drop the empties, and de-duplicate while preserving order. Every
/// provider mapping starts here so a sloppy dictionary (stray whitespace, a
/// phrase saved twice) can't inflate a query string or a prompt.
pub fn clean_vocabulary(vocabulary: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for term in vocabulary {
        let term = term.trim();
        if term.is_empty() || out.iter().any(|t| t == term) {
            continue;
        }
        out.push(term.to_string());
    }
    out
}

/// Percent-encode a string for use as a URL query-parameter VALUE. Vocabulary
/// terms are arbitrary user text (CJK, spaces, `&`, `=`), and several providers
/// take them as query params — encoding them by hand keeps the adapters free of
/// another dependency. Everything outside the RFC 3986 unreserved set is escaped.
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
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
    session: Option<u64>,
}

/// Live input level (0.0–1.0) emitted ~10×/s so the UI can show a meter.
#[derive(Clone, Serialize)]
struct LevelEvent {
    source: String,
    level: f32,
    session: Option<u64>,
}

/// Emit a single transcript segment update to the frontend.
#[allow(clippy::too_many_arguments)]
pub fn emit_segment(
    app: &AppHandle,
    event: &str,
    source: &str,
    id: String,
    speaker: i64,
    text: String,
    is_final: bool,
    start_ms: u64,
    end_ms: u64,
) {
    let _ = app.emit(
        event,
        TranscriptEvent {
            id,
            source: source.to_string(),
            speaker,
            text,
            is_final,
            start_ms,
            end_ms,
            session: session_for(source),
        },
    );
}

/// A leg's handshake completed (and its opening config frame went out, where
/// the protocol has one). Adapters call it right after that, once per leg:
/// - it emits [`CONNECTED_EVENT`] (`stt://connected`), which the voice-typing
///   host times its wait for the final answer from; `acks_finalize` says the
///   provider answers the closing finalize with an explicit end of stream;
/// - it confirms the leg to its bridge, which can now let go of its copies of
///   the audio fed to the leg (meetings only; voice typing has no bridge);
/// - it tells the meeting UI transcription is live (`meeting://transcription`,
///   state `live`), which drops its "reconnecting" banner. Voice typing has no
///   such surface.
pub fn note_connected(app: &AppHandle, source: &str, leg: u32, acks_finalize: bool) {
    let _ = app.emit(
        CONNECTED_EVENT,
        serde_json::json!({
            "source": source,
            "session": session_for(source),
            "acksFinalize": acks_finalize,
        }),
    );
    let _ = BRIDGE.try_with(|bridge| {
        if let Some(bridge) = bridge {
            bridge.confirm();
        }
    });
    if source == VOICE_TYPING_SOURCE {
        return;
    }
    let _ = app.emit(
        TRANSCRIPTION_STATE_EVENT,
        serde_json::json!({ "source": source, "state": "live", "leg": leg }),
    );
}

/// Bound a websocket handshake by [`CONNECT_TIMEOUT`]. An elapsed dial is a
/// plain "connect timed out" error, which `run_metered_session` classifies as
/// a connection failure (retryable in a meeting).
pub async fn with_connect_timeout<T>(
    connect: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    connect_within(CONNECT_TIMEOUT, connect).await
}

/// [`with_connect_timeout`] with the bound as a parameter, for tests.
async fn connect_within<T>(
    limit: Duration,
    connect: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(limit, connect).await {
        Ok(result) => result,
        Err(_elapsed) => Err(anyhow!("connect timed out")),
    }
}

/// Open a WebSocket with extra request headers (provider auth lives here).
/// Bounded by [`CONNECT_TIMEOUT`].
pub async fn connect_with_headers(
    url: &str,
    headers: &[(&str, String)],
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    ensure_crypto_provider();
    let mut req = url
        .into_client_request()
        .map_err(|e| anyhow!("bad ws url: {e}"))?;
    for (k, v) in headers {
        let name =
            HeaderName::from_bytes(k.as_bytes()).map_err(|e| anyhow!("bad header {k}: {e}"))?;
        let val = HeaderValue::from_str(v).map_err(|e| anyhow!("bad header value: {e}"))?;
        req.headers_mut().insert(name, val);
    }
    let (ws, _) = with_connect_timeout(async {
        tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| match &e {
                // Preserve the HTTP status from a refused upgrade (e.g. the hosted
                // relay's 402 quota / 401 expired-session) so the caller can surface
                // an actionable message instead of an opaque "connect failed".
                tokio_tungstenite::tungstenite::Error::Http(resp) => {
                    anyhow!("connect failed: HTTP {}", resp.status().as_u16())
                }
                _ => anyhow!("connect failed: {e}"),
            })
    })
    .await?;
    Ok(ws)
}

/// After a normal stop, how long the read half may take to answer the closing
/// handshake before the session ends anyway, counted from the drain (the
/// forward half sent its last audio). The abort backstops count from the cut
/// instead. `voice_typing::FLUSH_ABORT_GRACE` is built from this grace and
/// [`CONNECT_TIMEOUT`], so a dictation always ends here, in a normal return
/// (`stt://closed` fired), however late its socket connected. Meetings'
/// `teardown_meeting` still aborts 8 s after the cut: when the socket is
/// connected by then, the drain follows the cut at once and this grace ends
/// the session first; a connect that finishes more than about a second after
/// the cut pushes the drain, and this grace, past that abort — the usage
/// report survives it (capture.rs, `UsageReport`), the close does not.
pub const DRAIN_READ_GRACE: Duration = Duration::from_secs(7);

/// Drive a realtime session's two halves to completion and classify the
/// outcome. Every adapter hands over:
/// - `forward`: pumps PCM to the socket; resolves `true` when it drained its
///   input (the capture side closed — a normal stop) and `false` when a send
///   failed mid-stream (the socket died under it).
/// - `read_loop`: parses server frames; resolves `Err` on a terminal in-band
///   error, `Ok` when the stream ends any other way.
///
/// The classification rule: a session that ends while audio is still flowing
/// is a failure even when no explicit error frame arrived — otherwise a
/// mid-session disconnect is indistinguishable from successful silence
/// (frozen level meter, no transcript, no event; see `run_metered_session`'s
/// error surface). A normal stop instead awaits the read half so the
/// provider's final-token flush is delivered before the session resolves —
/// for at most [`DRAIN_READ_GRACE`]: the flush is the provider's answer to the
/// closing handshake, and one that never comes must not keep the session (and
/// its socket) alive until something aborts it.
pub async fn drive_session<F, R>(provider: &'static str, forward: F, read_loop: R) -> Result<()>
where
    F: std::future::Future<Output = bool>,
    R: std::future::Future<Output = Result<()>>,
{
    drive_session_with(provider, forward, read_loop, DRAIN_READ_GRACE).await
}

/// [`drive_session`] with the post-drain grace as a parameter, for tests.
async fn drive_session_with<F, R>(
    provider: &'static str,
    forward: F,
    read_loop: R,
    grace: Duration,
) -> Result<()>
where
    F: std::future::Future<Output = bool>,
    R: std::future::Future<Output = Result<()>>,
{
    tokio::pin!(forward);
    tokio::pin!(read_loop);
    tokio::select! {
        drained = &mut forward => {
            if drained {
                // Normal stop: wait for the final flush. A terminal in-band
                // error during the flush still surfaces; a flush that never
                // ends is cut after `grace` and counts as a normal end, since
                // every token it did deliver has already been emitted.
                match tokio::time::timeout(grace, read_loop).await {
                    Ok(result) => result,
                    Err(_elapsed) => {
                        log::warn!(
                            "{provider}: final flush not acknowledged within {grace:?}; ending the session"
                        );
                        Ok(())
                    }
                }
            } else {
                // A send failed, so the socket is gone. Give the read half a
                // short grace to deliver the server's explanation (an in-band
                // error frame beats a generic message) — but bounded, because
                // a half-dead connection can leave the read side hanging far
                // longer than the failure took.
                let death = || anyhow!("{provider} stream died mid-session (send failed)");
                match tokio::time::timeout(Duration::from_secs(5), read_loop).await {
                    Ok(read_result) => {
                        read_result?;
                        Err(death())
                    }
                    Err(_elapsed) => Err(death()),
                }
            }
        }
        result = &mut read_loop => {
            // The server ended the stream while audio was still flowing:
            // propagate its error frame, or report the unexplained death.
            result?;
            Err(anyhow!("{provider} stream ended mid-session"))
        }
    }
}

/// Tracks the peak of the captured PCM and emits a ~10 Hz level event. Adapters
/// call [`LevelMeter::push`] for every PCM chunk they forward.
pub struct LevelMeter {
    app: AppHandle,
    source: &'static str,
    event: &'static str,
    peak: i32,
    samples: u64,
    window: u64,
    enabled: bool,
}

impl LevelMeter {
    pub fn new(app: AppHandle, source: &'static str, event: &'static str) -> Self {
        Self {
            app,
            source,
            event,
            peak: 0,
            samples: 0,
            // 16 kHz / 1600 = 10 windows per second.
            window: TARGET_SAMPLE_RATE as u64 / 10,
            enabled: true,
        }
    }

    /// Mute (`false`) or keep (`true`) the meter — adapters pass
    /// [`TranscribeConfig::level_events`]. A muted meter ignores every push.
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    pub fn push(&mut self, chunk: &[i16]) {
        if !self.enabled {
            return;
        }
        for &s in chunk {
            self.peak = self.peak.max((s as i32).abs());
        }
        self.samples += chunk.len() as u64;
        if self.samples >= self.window {
            let level = (self.peak as f32 / 32767.0).clamp(0.0, 1.0);
            let _ = self.app.emit(
                self.event,
                LevelEvent {
                    source: self.source.to_string(),
                    level,
                    session: session_for(self.source),
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
///
/// Adapters work in the provider's own clock (zero at the leg's first sample)
/// and indices; the builder's [`Timeline`] moves every id and timestamp it
/// emits onto the meeting's, so a reconnected leg neither overwrites earlier
/// segments nor files its words at the start of the meeting.
pub struct SegmentBuilder {
    app: AppHandle,
    source: &'static str,
    event: &'static str,
    timeline: Timeline,
    seg_index: u64,
    /// Speaker of the open run, or `None` when no run is open.
    cur_speaker: Option<i64>,
    cur_final: String,
    cur_start: u64,
    cur_end: u64,
}

impl SegmentBuilder {
    pub fn new(
        app: AppHandle,
        source: &'static str,
        event: &'static str,
        timeline: Timeline,
    ) -> Self {
        Self {
            app,
            source,
            event,
            timeline,
            seg_index: 0,
            cur_speaker: None,
            cur_final: String::new(),
            cur_start: 0,
            cur_end: 0,
        }
    }

    /// The current open run's speaker (0 if none open) — useful for tail labels.
    pub fn current_speaker(&self) -> i64 {
        self.cur_speaker.unwrap_or(0)
    }

    /// The end timestamp of the current open run — useful as a tail start.
    /// In the provider's clock, like every timestamp an adapter passes in.
    pub fn current_end(&self) -> u64 {
        self.cur_end
    }

    /// Add a finalized token to the run. A speaker change closes the open run
    /// (emitting it solid) and starts a new one. Whitespace is preserved as the
    /// adapter supplies it.
    pub fn push_final(&mut self, text: &str, speaker: i64, start_ms: u64, end_ms: u64) {
        match self.cur_speaker {
            None => {
                self.cur_speaker = Some(speaker);
                self.cur_start = start_ms;
            }
            Some(cur) if speaker != cur => {
                if !self.cur_final.trim().is_empty() {
                    self.commit();
                }
                self.cur_speaker = Some(speaker);
                self.cur_final.clear();
                self.cur_start = start_ms;
            }
            Some(_) => {}
        }
        self.cur_final.push_str(text);
        self.cur_end = end_ms;
    }

    /// Emit the open run under its segment id (settled text), shifted onto
    /// the meeting's timeline.
    fn emit_open_run(&self) {
        emit_segment(
            &self.app,
            self.event,
            self.source,
            self.timeline.segment_id(self.source, self.seg_index),
            self.current_speaker(),
            self.cur_final.clone(),
            true,
            self.timeline.shift(self.cur_start),
            self.timeline.shift(self.cur_end),
        );
    }

    /// Emit the open run under a fresh segment id and advance the index.
    fn commit(&mut self) {
        self.emit_open_run();
        self.seg_index += 1;
    }

    /// Surface the current open run as solid (settled) text without advancing —
    /// it keeps growing under the same id until an endpoint or speaker change.
    pub fn emit_committed(&self) {
        if !self.cur_final.trim().is_empty() {
            self.emit_open_run();
        }
    }

    /// Emit the tentative tail under a stable `{source}-tail` id (empty text
    /// clears the previous tail in the UI). The id carries no leg: there is
    /// only ever one tentative tail, and a new leg's first tail replaces the
    /// dead leg's.
    pub fn emit_tail(&self, text: &str, speaker: i64, start_ms: u64) {
        let start_ms = self.timeline.shift(start_ms);
        emit_segment(
            &self.app,
            self.event,
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
        self.cur_speaker = None;
        self.cur_final.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connect that never answers fails the session (so the host shows an
    /// error and stops waiting) instead of parking it until the OS gives up.
    #[tokio::test]
    async fn a_connect_that_never_answers_times_out() {
        let limit = Duration::from_millis(20);
        let started = std::time::Instant::now();
        let r: Result<()> = connect_within(limit, std::future::pending()).await;
        assert_eq!(r.unwrap_err().to_string(), "connect timed out");
        assert!(started.elapsed() >= limit);
    }

    #[tokio::test]
    async fn a_connect_error_passes_through_the_timeout() {
        let r: Result<()> =
            with_connect_timeout(async { Err(anyhow!("connect failed: HTTP 402")) }).await;
        assert_eq!(r.unwrap_err().to_string(), "connect failed: HTTP 402");
    }

    #[test]
    fn clean_vocabulary_trims_drops_empties_and_dedupes_in_order() {
        let raw = vec![
            "  Parley ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "派勒".to_string(),
            "Parley".to_string(),
        ];
        assert_eq!(clean_vocabulary(&raw), vec!["Parley", "派勒"]);
    }

    /// A relay that neither closes nor acknowledges the finalize used to park
    /// the session on its read half until an 8 s abort skipped usage and close.
    #[tokio::test]
    async fn a_flush_that_never_ends_is_cut_after_the_grace_as_a_normal_end() {
        let grace = Duration::from_millis(30);
        let started = std::time::Instant::now();
        let result = drive_session_with(
            "test",
            async { true },
            futures_util::future::pending::<Result<()>>(),
            grace,
        )
        .await;
        assert!(result.is_ok());
        let took = started.elapsed();
        assert!(took >= grace, "returned after {took:?}");
        assert!(took < Duration::from_secs(2), "returned after {took:?}");
    }

    #[tokio::test]
    async fn an_error_during_the_flush_still_surfaces() {
        let result = drive_session_with(
            "test",
            async { true },
            async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Err(anyhow!("server error 401: bad key"))
            },
            Duration::from_secs(5),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("401"));
    }

    #[tokio::test]
    async fn a_read_loop_that_ends_while_audio_flows_is_a_failure() {
        let result = drive_session_with(
            "test",
            futures_util::future::pending::<bool>(),
            async { Ok(()) },
            Duration::from_secs(5),
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("ended mid-session"), "{error}");
    }

    #[test]
    fn urlencode_escapes_everything_outside_the_unreserved_set() {
        assert_eq!(urlencode("Parley"), "Parley");
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        // CJK must be escaped per UTF-8 byte, not per char.
        assert_eq!(urlencode("派"), "%E6%B4%BE");
    }

    #[test]
    fn the_first_leg_keeps_the_plain_segment_ids() {
        // Saved history and the frontend's upsert key on this exact shape.
        let first = Timeline::default();
        assert_eq!(first.segment_id("mix", 0), "mix-0");
        assert_eq!(first.segment_id("them", 12), "them-12");
        assert_eq!(first.shift(1_500), 1_500);
    }

    #[test]
    fn a_later_leg_namespaces_its_ids_and_shifts_its_clock() {
        let third = Timeline {
            leg: 2,
            offset_ms: 600_000,
        };
        // Its index restarts at zero but can't collide with leg 0's "mix-0".
        assert_eq!(third.segment_id("mix", 0), "mix@2-0");
        assert_eq!(third.segment_id("me", 7), "me@2-7");
        // Provider time zero is ten minutes into the meeting.
        assert_eq!(third.shift(0), 600_000);
        assert_eq!(third.shift(2_340), 602_340);
    }

    #[test]
    fn the_config_carries_its_timeline() {
        let config = TranscribeConfig {
            api_key: String::new(),
            model: String::new(),
            language_hints: Vec::new(),
            diarization: false,
            vocabulary: Vec::new(),
            relay_endpoint: None,
            leg: 3,
            time_offset_ms: 42,
            level_events: true,
        };
        assert_eq!(
            config.timeline(),
            Timeline {
                leg: 3,
                offset_ms: 42
            }
        );
    }
}
