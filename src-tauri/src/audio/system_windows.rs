//! System-audio capture on Windows via WASAPI loopback of the default render
//! device — the counterpart of the macOS process tap in `system_macos.rs`, and
//! the "them" source in a meeting.
//!
//! cpal 0.15's WASAPI host does the loopback part itself: opening an *input*
//! stream on an *output* device initializes the audio client with
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` (cpal `host/wasapi/device.rs`,
//! `build_input_stream_raw_inner`). Two cpal details shape the code below:
//!
//! - A render device reports no input configs (`supported_input_configs` is
//!   empty and `default_input_config` errors), so the stream is built from the
//!   device's `default_output_config` — its shared-mode mix format, which
//!   loopback capture always accepts.
//! - Every stream error ends cpal's capture thread, including
//!   `AUDCLNT_E_DEVICE_INVALIDATED` (endpoint unplugged, format changed in
//!   Sound settings, audio service restarted). The error callback therefore
//!   marks the stream dead and the supervisor here reopens it under
//!   [`ReopenPolicy`].
//!
//! Two Windows behaviours are handled on top:
//!
//! - Switching the default output device (plugging in a headset) does not
//!   invalidate the old endpoint; loopback would keep recording the device the
//!   call no longer plays on. The default device is polled once a second and
//!   the stream follows it.
//! - Loopback delivers no packets at all while nothing is rendering. The
//!   supervisor fills those gaps with silence ([`SilencePadder`]) so the stream
//!   is continuous in wall-clock time, as the macOS tap's is.
//!
//! No OS consent is involved — WASAPI loopback needs none — so there is no
//! permission watchdog like the macOS one; the only user-facing failure is "no
//! output device could be captured", reported once as
//! `system-audio-unavailable`.
//!
//! Known limit: the *default* render device (console role) is what gets
//! captured. A call app pinned to a different output device in its own
//! settings plays somewhere this source is not listening.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

use super::loopback::{downmix_to_mono, ReopenPolicy, SilencePadder};
use super::resample::LinearResampler;
use super::{AudioSource, TARGET_SAMPLE_RATE};

/// Supervisor wake-up when no audio arrives: bounds stop latency and the size
/// of each silence pad (20 ms = 320 samples at 16 kHz).
const TICK: Duration = Duration::from_millis(20);
/// How often the default render device is re-read to follow a switch.
const DEVICE_POLL: Duration = Duration::from_secs(1);

/// Whether there is a default render device to loop back from. The Windows
/// answer to "may Parley capture system audio" — loopback needs no consent, so
/// having something to capture is the whole condition. Side-effect free.
pub fn default_render_device_present() -> bool {
    cpal::default_host().default_output_device().is_some()
}

fn default_render_device_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}

/// System-audio capture ("them"). Holds an [`AppHandle`] so the capture thread
/// can tell the frontend when no output device can be captured.
pub struct SystemAudio {
    pub app: AppHandle,
}

impl AudioSource for SystemAudio {
    /// Never fails up front: a missing or unopenable output device is retried
    /// for the whole meeting (a headset may be connected later) while the
    /// stream carries silence, and the UI is warned if the outage lasts.
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let app = self.app.clone();
        let handle = std::thread::Builder::new()
            .name("parley-loopback".into())
            .spawn(move || supervise(tx, running, &app))?;
        Ok(handle)
    }
}

/// A running loopback stream plus what the supervisor needs to watch it.
struct Opened {
    /// Held only to keep the capture alive; dropping it stops cpal's thread.
    _stream: cpal::Stream,
    device_name: String,
    /// Set by the error callback — the stream has stopped for good.
    dead: Arc<AtomicBool>,
}

/// Own the loopback stream for the meeting: open it, follow the default device,
/// reopen it when it dies, pad silence, and forward everything to `tx` until
/// `running` clears or the consumer goes away.
fn supervise(tx: UnboundedSender<Vec<i16>>, running: Arc<AtomicBool>, app: &AppHandle) {
    let mut sup = Supervisor::new(tx, app);
    while running.load(Ordering::Relaxed) {
        let now = sup.started.elapsed();
        sup.watch_stream(now);
        sup.reopen_if_due(now);
        sup.warn_if_down(now);
        if !sup.forward() {
            break;
        }
    }
    // Dropping the stream stops cpal's capture thread and releases the device.
    drop(sup.current.take());
}

/// The capture thread's state, split into one method per duty so each stays
/// readable on its own.
struct Supervisor<'a> {
    app: &'a AppHandle,
    tx: UnboundedSender<Vec<i16>>,
    started: Instant,
    /// Every stream generation sends into this one channel, so a reopen is
    /// invisible downstream.
    pcm_tx: mpsc::Sender<Vec<i16>>,
    pcm_rx: mpsc::Receiver<Vec<i16>>,
    policy: ReopenPolicy,
    padder: SilencePadder,
    current: Option<Opened>,
    next_poll: Duration,
    /// Inside an outage: later open failures log at debug, not warn.
    failing: bool,
}

impl<'a> Supervisor<'a> {
    fn new(tx: UnboundedSender<Vec<i16>>, app: &'a AppHandle) -> Self {
        let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<i16>>();
        Self {
            app,
            tx,
            started: Instant::now(),
            pcm_tx,
            pcm_rx,
            policy: ReopenPolicy::new(),
            padder: SilencePadder::new(TARGET_SAMPLE_RATE),
            current: None,
            next_poll: Duration::ZERO,
            failing: false,
        }
    }

    /// Drop the running stream if it died or the default device moved away.
    fn watch_stream(&mut self, now: Duration) {
        let Some(opened) = &self.current else {
            return;
        };
        if opened.dead.load(Ordering::SeqCst) {
            self.current = None;
            let delay = self.policy.lost(now);
            log::warn!("[system] loopback stream lost; reopening in {delay:?}");
            return;
        }
        if now < self.next_poll {
            return;
        }
        self.next_poll = now + DEVICE_POLL;
        let default = default_render_device_name();
        if default.as_deref() != Some(opened.device_name.as_str()) {
            log::info!(
                "[system] default output changed ({:?} → {:?}); following it",
                opened.device_name,
                default
            );
            self.current = None;
            self.policy.switched(now);
        }
    }

    /// Open a stream when there is none and the reopen policy allows a try.
    fn reopen_if_due(&mut self, now: Duration) {
        if self.current.is_some() || !self.policy.should_try(now) {
            return;
        }
        match open(self.pcm_tx.clone()) {
            Ok(opened) => {
                self.policy.opened(now);
                self.next_poll = now + DEVICE_POLL;
                self.current = Some(opened);
                self.failing = false;
            }
            Err(e) => {
                let delay = self.policy.open_failed(now);
                // One line per outage, not one per retry.
                if self.failing {
                    log::debug!("[system] loopback still unavailable ({e}); next in {delay:?}");
                } else {
                    log::warn!("[system] loopback unavailable ({e}); retrying (next in {delay:?})");
                    self.failing = true;
                }
            }
        }
    }

    /// Tell the UI, once, that the meeting has been mic-only for a while.
    fn warn_if_down(&mut self, now: Duration) {
        if !self.policy.should_warn(now) {
            return;
        }
        log::warn!("[system] no output device captured for a while; meeting is mic-only");
        let _ = self.app.emit(
            "meeting://warning",
            serde_json::json!({
                "code": "system-audio-unavailable",
                "message": "no output device could be captured (WASAPI loopback)",
            }),
        );
    }

    /// Wait up to one tick for captured audio, forward it, then pad any
    /// silence that is due. `false` once the consumer is gone.
    fn forward(&mut self) -> bool {
        // `pcm_tx` lives in `self`, so the channel cannot disconnect; a
        // timeout just means nothing was rendered this tick.
        if let Ok(chunk) = self.pcm_rx.recv_timeout(TICK) {
            self.padder.on_audio(self.started.elapsed());
            if self.tx.send(chunk).is_err() {
                return false;
            }
        }
        let pad = self.padder.pad(self.started.elapsed());
        pad == 0 || self.tx.send(vec![0; pad]).is_ok()
    }
}

/// Open a loopback stream on the current default render device, resampling to
/// 16 kHz mono i16 into `pcm`.
fn open(pcm: mpsc::Sender<Vec<i16>>) -> Result<Opened> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| anyhow!("no default output device"))?;
    let device_name = device.name().unwrap_or_default();
    // The mix format: the only config a render device reports, and the one
    // shared-mode loopback always accepts.
    let supported = device.default_output_config()?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let dead = Arc::new(AtomicBool::new(false));

    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, pcm, dead.clone())?,
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, pcm, dead.clone())?,
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, pcm, dead.clone())?,
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, pcm, dead.clone())?,
        cpal::SampleFormat::U8 => build::<u8>(&device, &config, pcm, dead.clone())?,
        other => return Err(anyhow!("unsupported mix format: {other:?}")),
    };
    stream.play()?;
    log::info!(
        "[system] loopback on {:?} @ {} Hz, {} ch ({:?}) → {} Hz mono",
        device_name,
        config.sample_rate.0,
        config.channels,
        format,
        TARGET_SAMPLE_RATE
    );
    Ok(Opened {
        _stream: stream,
        device_name,
        dead,
    })
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    pcm: mpsc::Sender<Vec<i16>>,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut resampler = LinearResampler::new(config.sample_rate.0, TARGET_SAMPLE_RATE);
    // Opening an INPUT stream on an OUTPUT device is what makes cpal add
    // AUDCLNT_STREAMFLAGS_LOOPBACK.
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono = downmix_to_mono(data, channels);
            let mut out = Vec::new();
            resampler.process(&mono, &mut out);
            if !out.is_empty() {
                let _ = pcm.send(out);
            }
        },
        // cpal's WASAPI capture thread exits after reporting any error, so an
        // error here always means the stream is gone.
        move |e| {
            log::warn!("[system] loopback stream error: {e}");
            dead.store(true, Ordering::SeqCst);
        },
        None,
    )?;
    Ok(stream)
}
