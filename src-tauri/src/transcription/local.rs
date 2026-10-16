//! On-device transcription with whisper.cpp — the "local" provider.
//!
//! whisper.cpp is not a streaming recognizer: it transcribes a finished clip.
//! So the live stream is cut into utterances first, by a small energy-based
//! endpointer ([`Endpointer`]): an utterance opens on speech (with a short
//! pre-roll so word onsets are not clipped), closes after a stretch of trailing
//! silence, and is force-closed at [`VadConfig::max_utterance`] so a monologue
//! still reaches the screen. Each closed utterance is decoded on a blocking
//! worker and emitted as one committed segment. When the model runs on a GPU
//! (Metal on Apple Silicon, Vulkan on Windows), the growing utterance is also
//! re-decoded every couple of seconds and shown as the tentative tail.
//!
//! The model is loaded once and shared (see `local_stt::load_context`); each
//! session decodes with its own `WhisperState`. Nothing here touches the
//! network, so a session never "disconnects": it ends when its input closes,
//! or fails for good (model missing, load failure) with an error that starts
//! with "Local transcription", which the session loop never redials.
//!
//! Each session also times its final decodes ([`RtfTracker`]): when the
//! decoder cannot keep up with real time on this machine, it emits
//! `local-stt://slow` once so the UI can suggest a smaller model.
//!
//! Whisper does not diarize, so every segment is speaker 0.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperState};

use super::common::{
    clean_vocabulary, note_connected, LevelMeter, SegmentBuilder, TranscribeConfig, LEVEL_EVENT,
};
use super::error::SttError;
use crate::audio::TARGET_SAMPLE_RATE;
use crate::local_stt::{self, ModelFamily, ModelLease};

const SAMPLES_PER_MS: u64 = TARGET_SAMPLE_RATE as u64 / 1000;

/// Minimum gap between two interim decodes of the same session. Interim tails
/// re-decode the growing utterance, and only when the session's model runs on
/// a GPU (`local_stt::interim_tails`).
const INTERIM_EVERY: Duration = Duration::from_secs(2);
/// An utterance must hold this much audio before it is worth an interim decode.
const INTERIM_MIN_SAMPLES: usize = TARGET_SAMPLE_RATE as usize;
/// No audio at all for this long (a paused meeting) closes the open utterance,
/// instead of leaving it hanging until audio resumes.
const IDLE_FINALIZE: Duration = Duration::from_secs(1);

/// Longest initial prompt, in characters. Whisper keeps at most half its text
/// context for the prompt; a short one steers spelling and script without
/// crowding out the decode.
const PROMPT_MAX_CHARS: usize = 200;
/// Prepended when output should be Traditional Chinese. Whisper and Breeze emit
/// either script unpredictably; a Traditional prompt tips them reliably.
const TRADITIONAL_PREAMBLE: &str = "以下是繁體中文的逐字稿。";

// --- Endpointing ---------------------------------------------------------------

/// Tuning for [`Endpointer`]. All durations are in samples at 16 kHz.
#[derive(Clone, Copy, Debug)]
pub struct VadConfig {
    /// Analysis frame (20 ms).
    pub frame: usize,
    /// Consecutive speech frames that open an utterance (rejects clicks).
    pub onset_frames: usize,
    /// Audio kept from before the onset so the first word is not clipped.
    pub preroll: usize,
    /// Trailing silence that closes an utterance.
    pub end_silence: usize,
    /// Trailing silence kept on a closed utterance (whisper likes a little).
    pub trail_keep: usize,
    /// Utterances with less speech than this are dropped as noise.
    pub min_speech: usize,
    /// An utterance this long is closed even mid-speech.
    pub max_utterance: usize,
    /// Absolute RMS floor (normalized 0–1) below which nothing is speech.
    pub min_threshold: f32,
    /// A frame is speech when its RMS exceeds the noise floor by this factor.
    pub noise_ratio: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        let ms = |n: u64| (n * SAMPLES_PER_MS) as usize;
        Self {
            frame: ms(20),
            onset_frames: 3,
            preroll: ms(200),
            end_silence: ms(650),
            trail_keep: ms(250),
            min_speech: ms(300),
            max_utterance: ms(25_000),
            min_threshold: 0.008,
            noise_ratio: 3.0,
        }
    }
}

/// A closed utterance: its audio and where it starts in the stream.
#[derive(Debug)]
pub struct Utterance {
    pub id: u64,
    /// Index of `samples[0]` in the stream fed to the endpointer.
    pub start_sample: u64,
    pub samples: Vec<i16>,
}

impl Utterance {
    pub fn start_ms(&self) -> u64 {
        self.start_sample / SAMPLES_PER_MS
    }

    pub fn end_ms(&self) -> u64 {
        (self.start_sample + self.samples.len() as u64) / SAMPLES_PER_MS
    }
}

struct OpenUtterance {
    id: u64,
    start: u64,
    samples: Vec<i16>,
    speech: usize,
    silence_run: usize,
}

/// Energy-based utterance segmentation over 16 kHz mono PCM. Pure (no clock,
/// no I/O): the same input in any chunking yields the same utterances.
pub struct Endpointer {
    cfg: VadConfig,
    /// Samples of the frame being filled.
    pending: Vec<i16>,
    /// Stream position after the last complete frame.
    pos: u64,
    /// Recent audio while idle: the pre-roll plus the onset frames.
    history: VecDeque<i16>,
    noise: f32,
    onset_run: usize,
    open: Option<OpenUtterance>,
    next_id: u64,
}

impl Endpointer {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            pending: Vec::with_capacity(cfg.frame),
            pos: 0,
            history: VecDeque::new(),
            noise: cfg.min_threshold / cfg.noise_ratio,
            onset_run: 0,
            open: None,
            next_id: 0,
        }
    }

    /// Feed audio; returns the utterances it closed.
    pub fn push(&mut self, chunk: &[i16]) -> Vec<Utterance> {
        let mut out = Vec::new();
        let mut rest = chunk;
        while !rest.is_empty() {
            let take = (self.cfg.frame - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == self.cfg.frame {
                let frame = std::mem::take(&mut self.pending);
                if let Some(u) = self.frame(&frame) {
                    out.push(u);
                }
                self.pending = frame;
                self.pending.clear();
            }
        }
        out
    }

    /// Close the open utterance, if any (end of stream, or no audio for a
    /// while). Trailing silence is trimmed as for a normal close.
    pub fn finish(&mut self) -> Option<Utterance> {
        let open = self.open.take()?;
        self.close(open)
    }

    /// The utterance being collected: its id, start and audio so far.
    pub fn current(&self) -> Option<(u64, u64, &[i16])> {
        self.open
            .as_ref()
            .map(|o| (o.id, o.start, o.samples.as_slice()))
    }

    fn frame(&mut self, frame: &[i16]) -> Option<Utterance> {
        let cfg = self.cfg;
        self.pos += frame.len() as u64;
        let level = rms(frame);
        let threshold = (self.noise * cfg.noise_ratio).max(cfg.min_threshold);

        if let Some(open) = self.open.as_mut() {
            // Hysteresis: a word's decaying tail stays speech a little longer.
            let speech = level > threshold * 0.7;
            open.samples.extend_from_slice(frame);
            if speech {
                open.speech += frame.len();
                open.silence_run = 0;
            } else {
                open.silence_run += frame.len();
            }
            let done =
                open.silence_run >= cfg.end_silence || open.samples.len() >= cfg.max_utterance;
            if !speech {
                self.track_noise(level);
            }
            if done {
                let open = self.open.take()?;
                return self.close(open);
            }
            return None;
        }

        let speech = level > threshold;
        self.history.extend(frame.iter().copied());
        let cap = cfg.preroll + cfg.onset_frames * cfg.frame;
        while self.history.len() > cap {
            self.history.pop_front();
        }
        if speech {
            self.onset_run += 1;
        } else {
            self.onset_run = 0;
            self.track_noise(level);
        }
        if self.onset_run >= cfg.onset_frames {
            let samples: Vec<i16> = self.history.drain(..).collect();
            let start = self.pos - samples.len() as u64;
            self.open = Some(OpenUtterance {
                id: self.next_id,
                start,
                samples,
                speech: self.onset_run * cfg.frame,
                silence_run: 0,
            });
            self.next_id += 1;
            self.onset_run = 0;
        }
        None
    }

    /// Follow the background level on non-speech frames: falls fast, rises
    /// slowly, so a burst of noise does not deafen the detector.
    fn track_noise(&mut self, level: f32) {
        let rate = if level < self.noise { 0.3 } else { 0.05 };
        self.noise = (self.noise + (level - self.noise) * rate).clamp(0.0005, 0.05);
    }

    fn close(&mut self, mut open: OpenUtterance) -> Option<Utterance> {
        let cfg = self.cfg;
        let excess = open.silence_run.saturating_sub(cfg.trail_keep);
        open.samples
            .truncate(open.samples.len() - excess.min(open.samples.len()));
        if open.speech < cfg.min_speech {
            return None;
        }
        Some(Utterance {
            id: open.id,
            start_sample: open.start,
            samples: open.samples,
        })
    }
}

fn rms(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f64 = frame
        .iter()
        .map(|&s| {
            let x = s as f64 / 32768.0;
            x * x
        })
        .sum();
    (sum / frame.len() as f64).sqrt() as f32
}

// --- Language, prompt, and hallucination filtering ------------------------------

/// The whisper language for `hints`: exactly one hint pins it (region dropped,
/// "zh-TW" → "zh"); none or several mean auto-detect, which mixed
/// Chinese/English meetings rely on.
pub fn whisper_language(hints: &[String]) -> Option<String> {
    let mut hints = hints.iter().map(|h| h.trim()).filter(|h| !h.is_empty());
    let first = hints.next()?;
    if hints.next().is_some() {
        return None;
    }
    let base = first
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    (!base.is_empty() && base.chars().all(|c| c.is_ascii_lowercase())).then_some(base)
}

/// Whether a hint asks for Traditional Chinese specifically.
fn is_traditional_hint(hint: &str) -> bool {
    let h = hint.trim().to_ascii_lowercase().replace('_', "-");
    h == "zh-tw" || h == "zh-hk" || h == "zh-mo" || h.starts_with("zh-hant")
}

/// Whether to steer output toward Traditional Chinese: a Traditional hint, or
/// Breeze (a Taiwanese-Mandarin model) whenever Chinese is possible at all —
/// pinned to zh, or auto-detect with Chinese among the hints or no hints.
pub fn wants_traditional(hints: &[String], family: ModelFamily) -> bool {
    if hints.iter().any(|h| is_traditional_hint(h)) {
        return true;
    }
    family == ModelFamily::Breeze
        && (hints.iter().all(|h| h.trim().is_empty())
            || hints
                .iter()
                .any(|h| h.trim().to_ascii_lowercase().starts_with("zh")))
}

/// The initial prompt: the Traditional preamble (when wanted), the custom
/// vocabulary, and the end of the previous utterance's text — in that order,
/// since whisper weighs the end of the prompt most. Capped at
/// [`PROMPT_MAX_CHARS`]: the vocabulary is cut at a term boundary and the
/// previous text keeps its most recent characters.
pub fn build_prompt(traditional: bool, vocabulary: &[String], previous: &str) -> String {
    let mut prompt = String::new();
    if traditional {
        prompt.push_str(TRADITIONAL_PREAMBLE);
    }
    let terms = vocabulary_terms(vocabulary, prompt.chars().count());
    if !terms.is_empty() {
        if !prompt.is_empty() {
            prompt.push(' ');
        }
        prompt.push_str(&terms);
        prompt.push('.');
    }
    let room = PROMPT_MAX_CHARS.saturating_sub(prompt.chars().count() + 1);
    if let Some(tail) = previous_tail(previous.trim(), room) {
        if !prompt.is_empty() {
            prompt.push(' ');
        }
        prompt.push_str(tail.trim_start());
    }
    // A NUL would make whisper-rs panic building its C string.
    prompt.replace('\0', "")
}

/// The vocabulary as "a, b, c", cut at a term boundary so that a prompt
/// already `used` characters long, plus this list, its leading space and its
/// closing period, stays within [`PROMPT_MAX_CHARS`].
fn vocabulary_terms(vocabulary: &[String], mut used: usize) -> String {
    let mut terms = String::new();
    for term in vocabulary {
        let sep = if terms.is_empty() { 0 } else { 2 };
        let len = term.chars().count();
        // +2: the space before the list and its closing period.
        if used + sep + len + 2 > PROMPT_MAX_CHARS {
            break;
        }
        if sep > 0 {
            terms.push_str(", ");
        }
        terms.push_str(term);
        used += sep + len;
    }
    terms
}

/// The last `room` characters of the (trimmed) previous text, or `None` when
/// there is no previous text or no room for it.
fn previous_tail(previous: &str, room: usize) -> Option<String> {
    if previous.is_empty() || room == 0 {
        return None;
    }
    let count = previous.chars().count();
    Some(previous.chars().skip(count.saturating_sub(room)).collect())
}

/// Whisper's well-known inventions on silence and noise, compared after
/// [`normalize_for_match`]. Whole-text matches: phrases nobody says in a
/// meeting as the entire utterance.
const HALLUCINATION_EXACT: &[&str] = &[
    "thanks for watching",
    "thank you for watching",
    "thanks for watching and see you next time",
    "please subscribe",
    "like and subscribe",
    "please like and subscribe",
    "謝謝觀看",
    "谢谢观看",
    "感謝收看",
    "感谢收看",
    "感謝觀看",
    "感谢观看",
    "請訂閱",
    "请订阅",
    "訂閱",
    "订阅",
];

/// Substrings that only ever come from subtitle credits in the training data.
const HALLUCINATION_CONTAINS: &[&str] = &[
    "amara.org",
    "subtitles by",
    "字幕由",
    "字幕志愿者",
    "字幕志願者",
    "明镜与点点",
    "明鏡與點點",
    "点点栏目",
    "點點欄目",
    "請不吝點贊",
    "请不吝点赞",
    "訂閱我的頻道",
    "订阅我的频道",
];

/// Lowercase, drop punctuation and symbols, collapse whitespace.
fn normalize_for_match(text: &str) -> String {
    let kept: String = text
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c.is_whitespace() {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect();
    let joined = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.trim_matches('.').trim().to_string()
}

/// Whether the text is one short unit repeated over and over ("you you you
/// you", "謝謝謝謝謝謝謝謝") — whisper's decoding loop on noise.
fn is_repetition_loop(text: &str) -> bool {
    let chars: Vec<char> = text.chars().filter(|c| c.is_alphanumeric()).collect();
    if chars.len() < 8 {
        return false;
    }
    (1..=10.min(chars.len() / 4)).any(|period| {
        let same = (period..chars.len())
            .filter(|&i| chars[i] == chars[i - period])
            .count();
        same as f32 >= (chars.len() - period) as f32 * 0.9
    })
}

/// Whether a decoded text should be thrown away: empty or punctuation only, a
/// known silence hallucination, a repetition loop, or something whisper itself
/// thinks is not speech (high no-speech probability; a lower bar for very
/// short texts, which is where invented words hide).
pub fn is_hallucination(text: &str, no_speech_prob: f32) -> bool {
    let norm = normalize_for_match(text);
    if norm.chars().all(|c| !c.is_alphanumeric()) {
        return true;
    }
    if no_speech_prob > 0.8 || (no_speech_prob > 0.5 && norm.chars().count() < 10) {
        return true;
    }
    if HALLUCINATION_EXACT.contains(&norm.as_str()) {
        return true;
    }
    if HALLUCINATION_CONTAINS.iter().any(|s| norm.contains(s)) {
        return true;
    }
    is_repetition_loop(&norm)
}

// --- Real-time factor --------------------------------------------------------------

/// Decodes of utterances shorter than this are not timed: whisper pads every
/// clip and has a fixed per-decode cost, so short clips overstate the factor.
const RTF_MIN_AUDIO_MS: u64 = 2_000;
/// Timed decodes needed before the verdict can fire.
const RTF_MIN_DECODES: usize = 3;
/// The rolling window the median is taken over.
const RTF_WINDOW: usize = 5;
/// Median decode time ÷ audio time above which the decoder is falling behind
/// (a little under 1: the session also spends time outside the decode).
const RTF_SLOW: f32 = 0.9;

/// Watches the real-time factor (decode wall time ÷ audio duration) of a
/// session's FINAL decodes — interim decodes re-decode a growing utterance and
/// would skew it. After [`RTF_MIN_DECODES`] decodes of at least
/// [`RTF_MIN_AUDIO_MS`], a rolling median over the last [`RTF_WINDOW`] above
/// [`RTF_SLOW`] fires, once per tracker (= once per session). Pure: no clock.
#[derive(Debug, Default)]
pub struct RtfTracker {
    recent: VecDeque<f32>,
    fired: bool,
}

impl RtfTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one final decode; returns the median factor the first time the
    /// session is judged too slow, `None` otherwise.
    pub fn record(&mut self, audio_ms: u64, decode_ms: u64) -> Option<f32> {
        if self.fired || audio_ms < RTF_MIN_AUDIO_MS {
            return None;
        }
        self.recent.push_back(decode_ms as f32 / audio_ms as f32);
        if self.recent.len() > RTF_WINDOW {
            self.recent.pop_front();
        }
        if self.recent.len() < RTF_MIN_DECODES {
            return None;
        }
        let median = median(self.recent.iter().copied());
        if median > RTF_SLOW {
            self.fired = true;
            Some(median)
        } else {
            None
        }
    }
}

fn median(values: impl Iterator<Item = f32>) -> f32 {
    let mut v: Vec<f32> = values.collect();
    v.sort_by(f32::total_cmp);
    let n = v.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

// --- Decoding -------------------------------------------------------------------

/// One decoded stretch of an utterance, times relative to the clip start.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Session-wide decode settings.
#[derive(Clone)]
pub struct DecodeSettings {
    pub language: Option<String>,
    pub traditional: bool,
    pub vocabulary: Vec<String>,
    pub threads: i32,
}

impl DecodeSettings {
    pub fn new(config_hints: &[String], vocabulary: &[String], family: ModelFamily) -> Self {
        let mut language = whisper_language(config_hints);
        // An unknown code would fail the decode; auto-detect instead.
        if language
            .as_deref()
            .is_some_and(|l| whisper_rs::get_lang_id(l).is_none())
        {
            log::warn!("local-stt: language {language:?} unknown to whisper, auto-detecting");
            language = None;
        }
        Self {
            language,
            traditional: wants_traditional(config_hints, family),
            vocabulary: clean_vocabulary(vocabulary),
            threads: local_stt::thread_count(),
        }
    }
}

/// Whisper wants at least a second of audio; shorter clips are padded with
/// silence (it would otherwise decode nothing).
const MIN_DECODE_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 11 / 10;

/// Decode one clip. `timestamps` = per-segment times (file transcription); live
/// utterances decode as a single segment, which is faster.
pub fn decode(
    state: &mut WhisperState,
    settings: &DecodeSettings,
    audio: &[f32],
    previous: &str,
    timestamps: bool,
) -> Result<Vec<Decoded>, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(settings.threads);
    params.set_language(settings.language.as_deref());
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_no_timestamps(!timestamps);
    params.set_single_segment(!timestamps);
    let prompt = build_prompt(settings.traditional, &settings.vocabulary, previous);
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt);
    }
    let padded;
    let audio = if audio.len() < MIN_DECODE_SAMPLES {
        let mut v = audio.to_vec();
        v.resize(MIN_DECODE_SAMPLES, 0.0);
        padded = v;
        &padded[..]
    } else {
        audio
    };
    let clip_ms = audio.len() as u64 / SAMPLES_PER_MS;
    state
        .full(params, audio)
        .map_err(|e| format!("whisper decode failed: {e}"))?;
    let mut out = Vec::new();
    for segment in state.as_iter() {
        let text = segment
            .to_str_lossy()
            .map(|t| t.into_owned())
            .unwrap_or_default();
        if is_hallucination(&text, segment.no_speech_probability()) {
            continue;
        }
        let start_ms = (segment.start_timestamp().max(0) as u64 * 10).min(clip_ms);
        let end_ms = (segment.end_timestamp().max(0) as u64 * 10).clamp(start_ms, clip_ms);
        out.push(Decoded {
            text: text.trim().to_string(),
            start_ms,
            end_ms,
        });
    }
    Ok(out)
}

fn to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| s as f32 / 32768.0).collect()
}

/// The joined text of a live utterance's segments.
fn joined(decoded: &[Decoded]) -> String {
    let mut text = String::new();
    for d in decoded {
        // Latin words need a space between segments; CJK does not.
        let needs_space = text
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii() && !c.is_ascii_whitespace())
            && d.text
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if needs_space {
            text.push(' ');
        }
        text.push_str(&d.text);
    }
    text
}

// --- Live session -----------------------------------------------------------------

enum Job {
    Final(Utterance),
    Interim { id: u64, samples: Vec<i16> },
}

enum JobResult {
    Final {
        id: u64,
        start_ms: u64,
        end_ms: u64,
        text: String,
    },
    Interim {
        id: u64,
        text: String,
    },
    /// The worker could not start (no decoding state); the session is over.
    Fatal(String),
}

/// Decodes jobs in order on one blocking thread. Holds the previous final text
/// so each utterance is prompted with what came just before it, and times the
/// final decodes; `on_slow` is called (once) when they fall behind real time.
fn decode_worker(
    ctx: Arc<WhisperContext>,
    model_id: &str,
    settings: DecodeSettings,
    jobs: std::sync::mpsc::Receiver<Job>,
    results: tokio::sync::mpsc::UnboundedSender<JobResult>,
    mut on_slow: impl FnMut(f32),
) {
    let mut state = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("local-stt: {model_id} could not create a decoding state: {e}");
            let msg =
                local_stt::init_failure_message(model_id, "could not create a decoding state", e);
            let _ = results.send(JobResult::Fatal(msg));
            return;
        }
    };
    let mut previous = String::new();
    let mut rtf = RtfTracker::new();
    while let Ok(job) = jobs.recv() {
        let result = match job {
            Job::Final(utt) => {
                let started = Instant::now();
                let text = match decode(
                    &mut state,
                    &settings,
                    &to_f32(&utt.samples),
                    &previous,
                    false,
                ) {
                    Ok(d) => joined(&d),
                    Err(e) => {
                        log::warn!("local-stt: utterance {} dropped: {e}", utt.id);
                        String::new()
                    }
                };
                let audio_ms = utt.end_ms() - utt.start_ms();
                let decode_ms = started.elapsed().as_millis() as u64;
                log::debug!(
                    "local-stt: utterance {} ({audio_ms} ms audio) decoded in {decode_ms} ms",
                    utt.id
                );
                if let Some(factor) = rtf.record(audio_ms, decode_ms) {
                    on_slow(factor);
                }
                if !text.is_empty() {
                    previous.clone_from(&text);
                }
                JobResult::Final {
                    id: utt.id,
                    start_ms: utt.start_ms(),
                    end_ms: utt.end_ms(),
                    text,
                }
            }
            Job::Interim { id, samples } => {
                let text = decode(&mut state, &settings, &to_f32(&samples), &previous, false)
                    .map(|d| joined(&d))
                    .unwrap_or_default();
                JobResult::Interim { id, text }
            }
        };
        if results.send(result).is_err() {
            return;
        }
    }
}

/// Load the session's model (blocking, off the runtime), holding a lease on it.
/// Also returns what it runs on (the GPU load may have fallen back to the CPU).
async fn load(app: &AppHandle, model_id: &str) -> Result<(Arc<WhisperContext>, local_stt::Accel)> {
    let app = app.clone();
    let id = model_id.to_string();
    tauri::async_runtime::spawn_blocking(move || local_stt::load_context(&app, &id))
        .await
        .map_err(|e| SttError::local(format!("Local transcription model load panicked: {e}")))?
        .map_err(SttError::local)
}

/// Emits decode results and tracks the tentative tail.
struct Emitter {
    builder: SegmentBuilder,
    /// The utterance the shown tail belongs to.
    tail_for: Option<u64>,
}

impl Emitter {
    fn apply(&mut self, result: JobResult, current: Option<(u64, u64)>) -> Result<()> {
        match result {
            JobResult::Final {
                id,
                start_ms,
                end_ms,
                text,
            } => {
                if !text.is_empty() {
                    self.builder.push_final(&text, 0, start_ms, end_ms);
                    self.builder.emit_committed();
                    self.builder.endpoint();
                }
                if self.tail_for == Some(id) {
                    self.builder.emit_tail("", 0, 0);
                    self.tail_for = None;
                }
            }
            JobResult::Interim { id, text } => {
                // Only while that utterance is still open: once it closed, its
                // final is next in the queue and the tail would flash stale text.
                if let Some((open_id, start_ms)) = current {
                    if open_id == id && !text.is_empty() {
                        self.builder.emit_tail(&text, 0, start_ms);
                        self.tail_for = Some(id);
                    }
                }
            }
            // Already a final "Local transcription …" message (see
            // local_stt::init_failure_message), memory-specific when it fits.
            JobResult::Fatal(msg) => return Err(SttError::local(msg)),
        }
        Ok(())
    }
}

/// `run_session`'s side of the decode worker's queue: how many jobs are
/// queued or running, and when the last interim went out.
struct JobQueue {
    tx: std::sync::mpsc::Sender<Job>,
    outstanding: usize,
    last_interim: Instant,
}

impl JobQueue {
    fn new(tx: std::sync::mpsc::Sender<Job>) -> Self {
        Self {
            tx,
            outstanding: 0,
            last_interim: Instant::now(),
        }
    }

    /// Queue a job; false when the worker is gone.
    fn send(&mut self, job: Job) -> bool {
        let sent = self.tx.send(job).is_ok();
        if sent {
            self.outstanding += 1;
        }
        sent
    }

    fn result_received(&mut self) {
        self.outstanding = self.outstanding.saturating_sub(1);
    }

    /// Ask for an interim of the open utterance, at most every
    /// [`INTERIM_EVERY`] and once it has [`INTERIM_MIN_SAMPLES`]. One decode at
    /// a time: an interim only goes out when nothing is queued or running, so
    /// it can never delay a final.
    fn maybe_send_interim(&mut self, endpointer: &Endpointer) {
        if self.outstanding > 0 || self.last_interim.elapsed() < INTERIM_EVERY {
            return;
        }
        let Some((id, _, samples)) = endpointer.current() else {
            return;
        };
        if samples.len() < INTERIM_MIN_SAMPLES {
            return;
        }
        let job = Job::Interim {
            id,
            samples: samples.to_vec(),
        };
        if self.send(job) {
            self.last_interim = Instant::now();
        }
    }
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let model_id = local_stt::resolve_model_id(&config.model).to_string();
    let entry = local_stt::entry(&model_id).ok_or_else(|| {
        SttError::local(format!(
            "Local transcription model '{model_id}' is unknown."
        ))
    })?;
    let _lease = ModelLease::new(&model_id);
    let started = Instant::now();
    let (ctx, accel) = load(&app, &model_id).await?;
    let interim_tails = local_stt::interim_tails(accel);
    let settings = DecodeSettings::new(&config.language_hints, &config.vocabulary, entry.family);
    log::info!(
        "[local:{source}] ready in {}ms, model={model_id} accel={accel:?} language={:?} traditional={} leg={}",
        started.elapsed().as_millis(),
        settings.language,
        settings.traditional,
        config.leg
    );
    // `true`: the session ends (stt://closed) only after the last utterance is
    // decoded, so the voice-typing host waits for that instead of guessing.
    note_connected(&app, source, config.leg, true);

    let mut meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);
    let mut emitter = Emitter {
        builder: SegmentBuilder::to_frontend(app.clone(), source, config.timeline()),
        tail_for: None,
    };
    let (job_tx, job_rx) = std::sync::mpsc::channel::<Job>();
    let mut jobs = JobQueue::new(job_tx);
    let (res_tx, mut res_rx) = tokio::sync::mpsc::unbounded_channel::<JobResult>();
    let worker_app = app.clone();
    let worker_model = model_id.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        decode_worker(ctx, &worker_model, settings, job_rx, res_tx, |rtf| {
            local_stt::emit_slow(&worker_app, &worker_model, rtf)
        })
    });

    let mut endpointer = Endpointer::new(VadConfig::default());
    let mut last_audio = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let current = |ep: &Endpointer| {
        ep.current()
            .map(|(id, start, _)| (id, start / SAMPLES_PER_MS))
    };

    loop {
        let mut closed = Vec::new();
        tokio::select! {
            chunk = pcm_rx.recv() => {
                let Some(chunk) = chunk else { break };
                meter.push(&chunk);
                last_audio = Instant::now();
                closed = endpointer.push(&chunk);
            }
            Some(result) = res_rx.recv() => {
                jobs.result_received();
                emitter.apply(result, current(&endpointer))?;
            }
            _ = ticker.tick() => {
                if last_audio.elapsed() >= IDLE_FINALIZE {
                    closed.extend(endpointer.finish());
                }
            }
        }
        for utt in closed {
            jobs.send(Job::Final(utt));
        }
        if interim_tails {
            jobs.maybe_send_interim(&endpointer);
        }
    }

    // Input closed: a normal stop. Decode what is left, then end.
    if let Some(utt) = endpointer.finish() {
        jobs.send(Job::Final(utt));
    }
    drop(jobs);
    while let Some(result) = res_rx.recv().await {
        emitter.apply(result, None)?;
    }
    let _ = worker.await;
    if emitter.tail_for.is_some() {
        emitter.builder.emit_tail("", 0, 0);
    }
    log::info!("[local:{source}] session ended");
    Ok(())
}

// --- File transcription -----------------------------------------------------------

/// Transcribe a whole recording on-device: decode to 16 kHz mono, cut it into
/// utterances with the same endpointer as the live path (whisper invents text
/// on long silences, and per-utterance prompting keeps context), and decode
/// each with segment timestamps. Returns `(text, start_ms, end_ms)` per segment
/// and the audio duration in ms. Blocking — run it from `spawn_blocking`.
pub fn transcribe_file_blocking(
    app: &AppHandle,
    path: &std::path::Path,
    model: &str,
    language_hints: &[String],
    vocabulary: &[String],
) -> Result<(Vec<Decoded>, u64), String> {
    let model_id = local_stt::resolve_model_id(model);
    let entry = local_stt::entry(model_id)
        .ok_or_else(|| format!("Local transcription model '{model_id}' is unknown."))?;
    let _lease = ModelLease::new(model_id);
    let (ctx, _) = local_stt::load_context(app, model_id)?;
    let settings = DecodeSettings::new(language_hints, vocabulary, entry.family);
    let audio = crate::replay_audio::decode_to_16k_mono(path)
        .map_err(|e| format!("Could not decode the recording: {e:#}"))?;
    let duration_ms = audio.len() as u64 / SAMPLES_PER_MS;
    let started = Instant::now();
    let out = transcribe_samples(model_id, &ctx, &settings, &audio, |rtf| {
        local_stt::emit_slow(app, model_id, rtf)
    })?;
    log::info!(
        "local-stt: transcribed {} s of audio with {model_id} in {} ms ({} segments)",
        duration_ms / 1000,
        started.elapsed().as_millis(),
        out.len()
    );
    Ok((out, duration_ms))
}

/// The core of [`transcribe_file_blocking`] over already-decoded 16 kHz audio.
/// Times each utterance's decode like the live path; `on_slow` is called once
/// when they fall behind real time.
fn transcribe_samples(
    model_id: &str,
    ctx: &WhisperContext,
    settings: &DecodeSettings,
    audio: &[f32],
    mut on_slow: impl FnMut(f32),
) -> Result<Vec<Decoded>, String> {
    let mut state = ctx.create_state().map_err(|e| {
        log::warn!("local-stt: {model_id} could not create a decoding state: {e}");
        local_stt::init_failure_message(model_id, "could not create a decoding state", e)
    })?;
    let mut endpointer = Endpointer::new(VadConfig::default());
    let mut previous = String::new();
    let mut out: Vec<Decoded> = Vec::new();
    let mut rtf = RtfTracker::new();
    let mut run = |utt: Utterance, out: &mut Vec<Decoded>, previous: &mut String| {
        let start = utt.start_sample as usize;
        let end = (start + utt.samples.len()).min(audio.len());
        let started = Instant::now();
        let decoded = decode(&mut state, settings, &audio[start..end], previous, true);
        if let Some(factor) = rtf.record(
            utt.end_ms() - utt.start_ms(),
            started.elapsed().as_millis() as u64,
        ) {
            on_slow(factor);
        }
        match decoded {
            Ok(segments) => {
                let text = joined(&segments);
                if !text.is_empty() {
                    *previous = text;
                }
                let offset = utt.start_ms();
                out.extend(segments.into_iter().map(|d| Decoded {
                    text: d.text,
                    start_ms: offset + d.start_ms,
                    end_ms: (offset + d.end_ms).min(utt.end_ms()),
                }));
            }
            Err(e) => log::warn!("local-stt: file utterance {} dropped: {e}", utt.id),
        }
    };
    let pcm: Vec<i16> = audio
        .iter()
        .map(|&x| (x.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();
    for chunk in pcm.chunks(TARGET_SAMPLE_RATE as usize) {
        for utt in endpointer.push(chunk) {
            run(utt, &mut out, &mut previous);
        }
    }
    if let Some(utt) = endpointer.finish() {
        run(utt, &mut out, &mut previous);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_results_become_runs_and_a_tail_for_the_open_utterance() {
        use crate::transcription::common::testing::{builder, rows, seg};
        let (builder, out) = builder("me");
        let mut emitter = Emitter {
            builder,
            tail_for: None,
        };
        let interim = |id: u64, text: &str| JobResult::Interim {
            id,
            text: text.to_string(),
        };
        emitter.apply(interim(1, "hel"), Some((1, 200))).unwrap();
        // Not the open utterance (its final is next in the queue): dropped.
        emitter.apply(interim(2, "stale"), Some((1, 200))).unwrap();
        emitter.apply(interim(1, "x"), None).unwrap();
        let final_result = |id: u64, text: &str| JobResult::Final {
            id,
            start_ms: 200,
            end_ms: 900,
            text: text.to_string(),
        };
        emitter.apply(final_result(1, " hello"), None).unwrap();
        emitter.apply(final_result(2, ""), None).unwrap();
        assert_eq!(
            rows(&out),
            vec![
                seg("me-tail", 0, "hel", false, 200, 200),
                seg("me-0", 0, " hello", true, 200, 900),
                seg("me-0", 0, " hello", true, 200, 900),
                seg("me-tail", 0, "", false, 0, 0),
            ]
        );
        let fatal = JobResult::Fatal("Local transcription model 'm' failed to load: x".into());
        assert_eq!(
            emitter.apply(fatal, None).unwrap_err().to_string(),
            "Local transcription model 'm' failed to load: x"
        );
    }

    const SR: usize = TARGET_SAMPLE_RATE as usize;

    fn silence(ms: usize) -> Vec<i16> {
        // A faint, deterministic hiss rather than digital zero.
        (0..ms * SR / 1000)
            .map(|i| if i % 2 == 0 { 30 } else { -30 })
            .collect()
    }

    fn tone(ms: usize) -> Vec<i16> {
        (0..ms * SR / 1000)
            .map(|i| {
                let t = i as f32 / SR as f32;
                ((t * 220.0 * std::f32::consts::TAU).sin() * 9000.0) as i16
            })
            .collect()
    }

    fn run(input: &[i16], chunk: usize) -> Vec<Utterance> {
        let mut ep = Endpointer::new(VadConfig::default());
        let mut out = Vec::new();
        for c in input.chunks(chunk) {
            out.extend(ep.push(c));
        }
        out.extend(ep.finish());
        out
    }

    fn concat(parts: &[Vec<i16>]) -> Vec<i16> {
        parts.concat()
    }

    #[test]
    fn one_burst_is_one_utterance_with_preroll_and_trimmed_tail() {
        let input = concat(&[silence(1000), tone(1000), silence(1500)]);
        let utts = run(&input, 1600);
        assert_eq!(utts.len(), 1);
        let u = &utts[0];
        // Pre-roll: starts ~200 ms before the onset.
        assert!(
            (780..=820).contains(&u.start_ms()),
            "start {}",
            u.start_ms()
        );
        // Ends ~250 ms of kept silence after the tone (at 2000 ms).
        assert!((2200..=2320).contains(&u.end_ms()), "end {}", u.end_ms());
    }

    #[test]
    fn chunking_does_not_change_the_result() {
        let input = concat(&[
            silence(500),
            tone(800),
            silence(900),
            tone(600),
            silence(1000),
        ]);
        let a = run(&input, 160);
        let b = run(&input, 4801);
        assert_eq!(a.len(), 2);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.start_sample, y.start_sample);
            assert_eq!(x.samples.len(), y.samples.len());
        }
        assert_eq!(a[0].id, 0);
        assert_eq!(a[1].id, 1);
    }

    #[test]
    fn a_short_pause_does_not_split_an_utterance() {
        let input = concat(&[
            silence(500),
            tone(700),
            silence(400),
            tone(700),
            silence(1000),
        ]);
        assert_eq!(run(&input, 1600).len(), 1);
    }

    #[test]
    fn clicks_and_short_blips_are_dropped() {
        // 40 ms: below the onset. 200 ms: opens, but under the speech minimum.
        let input = concat(&[
            silence(500),
            tone(40),
            silence(800),
            tone(200),
            silence(1000),
        ]);
        assert!(run(&input, 1600).is_empty());
    }

    #[test]
    fn silence_alone_yields_nothing() {
        assert!(run(&silence(5000), 1600).is_empty());
    }

    #[test]
    fn a_monologue_is_force_split_at_the_cap() {
        let input = concat(&[silence(300), tone(30_000), silence(1000)]);
        let utts = run(&input, 1600);
        assert_eq!(
            utts.len(),
            2,
            "{:?}",
            utts.iter().map(|u| u.samples.len()).collect::<Vec<_>>()
        );
        assert_eq!(utts[0].samples.len(), VadConfig::default().max_utterance);
        // The second piece continues where the first stopped (no audio lost
        // beyond the onset frames re-collected after the cut).
        let gap = utts[1].start_sample - (utts[0].start_sample + utts[0].samples.len() as u64);
        assert!(gap <= 3 * 320, "gap {gap}");
    }

    #[test]
    fn finish_closes_an_open_utterance() {
        let mut ep = Endpointer::new(VadConfig::default());
        assert!(ep.push(&concat(&[silence(300), tone(900)])).is_empty());
        assert!(ep.current().is_some());
        let u = ep.finish().expect("open utterance");
        assert!(u.samples.len() >= 900 * SR / 1000);
        assert!(ep.current().is_none());
        assert!(ep.finish().is_none());
    }

    #[test]
    fn language_hints_map_to_whisper_codes() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(whisper_language(&s(&["zh-TW"])), Some("zh".into()));
        assert_eq!(whisper_language(&s(&["en"])), Some("en".into()));
        assert_eq!(whisper_language(&s(&["ja_JP"])), Some("ja".into()));
        assert_eq!(whisper_language(&s(&[" EN-us "])), Some("en".into()));
        // Mixed meetings must auto-detect.
        assert_eq!(whisper_language(&s(&["zh-TW", "en"])), None);
        assert_eq!(whisper_language(&s(&[])), None);
        assert_eq!(whisper_language(&s(&["", " "])), None);
    }

    #[test]
    fn traditional_output_is_steered_for_taiwan_and_breeze() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(wants_traditional(&s(&["zh-TW"]), ModelFamily::Whisper));
        assert!(wants_traditional(&s(&["zh-Hant"]), ModelFamily::Whisper));
        assert!(!wants_traditional(&s(&["zh"]), ModelFamily::Whisper));
        assert!(!wants_traditional(&s(&["zh-CN"]), ModelFamily::Whisper));
        assert!(!wants_traditional(&s(&[]), ModelFamily::Whisper));
        assert!(wants_traditional(&s(&["zh"]), ModelFamily::Breeze));
        assert!(wants_traditional(&s(&["zh", "en"]), ModelFamily::Breeze));
        assert!(wants_traditional(&s(&[]), ModelFamily::Breeze));
        assert!(!wants_traditional(&s(&["en"]), ModelFamily::Breeze));
    }

    #[test]
    fn the_prompt_orders_preamble_vocabulary_then_history() {
        let vocab = vec!["Parley".to_string(), "派勒".to_string()];
        assert_eq!(build_prompt(false, &[], ""), "");
        assert_eq!(build_prompt(false, &vocab, ""), "Parley, 派勒.");
        assert_eq!(
            build_prompt(true, &vocab, "上一句。"),
            format!("{TRADITIONAL_PREAMBLE} Parley, 派勒. 上一句。")
        );
        assert_eq!(build_prompt(false, &[], "  hello there "), "hello there");
    }

    #[test]
    fn the_prompt_is_capped_and_keeps_the_latest_history() {
        let vocab: Vec<String> = (0..100).map(|i| format!("term{i}")).collect();
        let history = "x".repeat(500) + "END";
        let p = build_prompt(true, &vocab, &history);
        assert!(
            p.chars().count() <= PROMPT_MAX_CHARS,
            "{}",
            p.chars().count()
        );
        assert!(p.starts_with(TRADITIONAL_PREAMBLE));
        // Vocabulary is cut at a term boundary.
        assert!(!p.contains("term99"));
        let p = build_prompt(false, &[], &history);
        assert!(p.ends_with("END"));
        assert!(p.chars().count() <= PROMPT_MAX_CHARS);
        assert!(!build_prompt(false, &["a\0b".to_string()], "").contains('\0'));
    }

    #[test]
    fn known_silence_hallucinations_are_dropped() {
        assert!(is_hallucination("", 0.0));
        assert!(is_hallucination("  ...  ", 0.0));
        assert!(is_hallucination(" Thanks for watching!", 0.1));
        assert!(is_hallucination("謝謝觀看。", 0.1));
        assert!(is_hallucination("字幕由Amara.org社区提供", 0.0));
        assert!(is_hallucination(
            "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
            0.0
        ));
        assert!(is_hallucination("you you you you you you", 0.0));
        assert!(is_hallucination("謝謝謝謝謝謝謝謝謝謝", 0.0));
        // Whisper's own verdict.
        assert!(is_hallucination("Okay.", 0.6));
        assert!(is_hallucination("This is a longer sentence of text", 0.9));
    }

    #[test]
    fn real_speech_is_kept() {
        assert!(!is_hallucination("Thank you.", 0.1));
        assert!(!is_hallucination("我們下週再確認一下報價。", 0.2));
        assert!(!is_hallucination(
            "Let's look at the Q3 numbers first.",
            0.3
        ));
        assert!(!is_hallucination("This is a longer sentence of text", 0.6));
        assert!(!is_hallucination("OK", 0.1));
        // Watching is fine in context.
        assert!(!is_hallucination(
            "Thanks for watching the demo with us today",
            0.1
        ));
    }

    #[test]
    fn segments_join_with_spaces_only_between_latin_words() {
        let d = |t: &str| Decoded {
            text: t.to_string(),
            start_ms: 0,
            end_ms: 0,
        };
        assert_eq!(joined(&[d("Hello"), d("world")]), "Hello world");
        assert_eq!(joined(&[d("你好"), d("世界")]), "你好世界");
        assert_eq!(joined(&[d("Hello."), d("Next")]), "Hello. Next");
        assert_eq!(joined(&[d("OK."), d("好")]), "OK.好");
    }

    #[test]
    fn the_rtf_tracker_needs_three_long_decodes_before_judging() {
        let mut t = RtfTracker::new();
        // Slow, but each too short to count.
        for _ in 0..10 {
            assert_eq!(t.record(1_500, 3_000), None);
        }
        assert_eq!(t.record(4_000, 6_000), None);
        assert_eq!(t.record(4_000, 6_000), None);
        // Third long decode: median 1.5 > 0.9.
        assert_eq!(t.record(4_000, 6_000), Some(1.5));
    }

    #[test]
    fn the_rtf_tracker_fires_once_per_session() {
        let mut t = RtfTracker::new();
        let fired: Vec<_> = (0..20).filter_map(|_| t.record(3_000, 6_000)).collect();
        assert_eq!(fired, vec![2.0]);
    }

    #[test]
    fn a_fast_decoder_never_fires() {
        let mut t = RtfTracker::new();
        for _ in 0..50 {
            assert_eq!(t.record(5_000, 1_000), None);
        }
    }

    #[test]
    fn the_rtf_tracker_uses_a_rolling_median() {
        let mut t = RtfTracker::new();
        // One huge outlier (a model load hiccup) among fast decodes: the median
        // stays fast.
        assert_eq!(t.record(5_000, 50_000), None);
        assert_eq!(t.record(5_000, 1_000), None);
        assert_eq!(t.record(5_000, 1_000), None);
        assert_eq!(t.record(5_000, 1_000), None);
        // The machine then slows down for good: once slow decodes are the
        // majority of the last five, it fires.
        assert_eq!(t.record(5_000, 6_000), None);
        assert_eq!(t.record(5_000, 6_000), None);
        assert_eq!(t.record(5_000, 6_000), Some(1.2));
        // The boundary itself (exactly 0.9) is not slow.
        let mut t = RtfTracker::new();
        for _ in 0..5 {
            assert_eq!(t.record(10_000, 9_000), None);
        }
    }

    /// Real-model smoke test, skipped by default: set PARLEY_LOCAL_STT_MODEL to
    /// a GGML model file and PARLEY_LOCAL_STT_AUDIO to an audio file, then run
    /// `cargo test --lib smoke_transcribe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn smoke_transcribe() {
        let model = std::env::var("PARLEY_LOCAL_STT_MODEL").expect("PARLEY_LOCAL_STT_MODEL");
        let audio = std::env::var("PARLEY_LOCAL_STT_AUDIO").expect("PARLEY_LOCAL_STT_AUDIO");
        let hints: Vec<String> = std::env::var("PARLEY_LOCAL_STT_LANG")
            .map(|l| l.split(',').map(str::to_string).collect())
            .unwrap_or_default();
        let accel = local_stt::accel();
        let t = Instant::now();
        let ctx =
            WhisperContext::new_with_params(&model, local_stt::context_params(accel)).unwrap();
        println!("load on {accel:?}: {} ms", t.elapsed().as_millis());
        let pcm = crate::replay_audio::decode_to_16k_mono(std::path::Path::new(&audio)).unwrap();
        let settings = DecodeSettings::new(&hints, &[], ModelFamily::Whisper);
        let t = Instant::now();
        let out = transcribe_samples("smoke", &ctx, &settings, &pcm, |rtf| {
            println!("slow: median RTF {rtf:.2}")
        })
        .unwrap();
        println!(
            "transcribe: {} ms for {} ms of audio",
            t.elapsed().as_millis(),
            pcm.len() / SR * 1000
        );
        for d in &out {
            println!("[{} - {}] {}", d.start_ms, d.end_ms, d.text);
        }
        assert!(!out.is_empty());
    }
}
