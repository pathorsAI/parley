//! Audio *playback* for the live-translation feature — the one place in Parley
//! that opens a CoreAudio **output** stream (everything else only captures).
//!
//! Gemini Live Translate returns 24 kHz mono s16le audio in bursts. We can't
//! feed those bursts straight to the sound card (an output stream pulls at a
//! steady device rate), so a [`PlaybackSink`] resamples each burst to the
//! device rate and appends it to a shared jitter buffer; the output stream's
//! realtime callback drains that buffer one device frame at a time, emitting
//! silence when it runs dry. The buffer is capped so a producer that ever runs
//! ahead can't grow latency without bound.
//!
//! Phase 1 plays to any chosen output device (headphones, for validation). In
//! Phase 2 the same sink points at the bundled "Parley Microphone" virtual
//! device so Google Meet hears the translation.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
// `EQUILIBRIUM` (silence) resolves through `SizedSample`'s `Sample` supertrait,
// so `Sample` needn't be imported by name.
use cpal::{FromSample, SizedSample};

use super::resample::LinearResampler;

/// Sample rate of the audio Gemini Live Translate emits (raw s16le mono).
pub const TRANSLATE_OUTPUT_RATE: u32 = 24_000;

/// List the names of available output devices, for the settings picker.
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    let mut names = Vec::new();
    if let Ok(devices) = host.output_devices() {
        for d in devices {
            if let Ok(name) = d.name() {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// Producer end of the jitter buffer. The translate session pushes decoded
/// 24 kHz PCM here; it is resampled to the device rate and enqueued for the
/// output callback. `push` is cheap (resample + a short lock).
pub struct PlaybackSink {
    ring: Arc<Mutex<VecDeque<i16>>>,
    /// 24 kHz → device rate, kept across pushes so bursts stay phase-continuous.
    resampler: LinearResampler,
    /// Cap on buffered device-rate samples (~2 s) — a safety valve so a producer
    /// transiently ahead of the sound card can't grow playback latency forever.
    max_samples: usize,
}

impl PlaybackSink {
    /// Enqueue a burst of 24 kHz mono s16le PCM for playback. Oldest samples are
    /// dropped if the buffer is over its cap (bounds added latency).
    pub fn push(&mut self, pcm_24k: &[i16]) {
        // LinearResampler consumes mono f32 in [-1, 1] and emits i16 at the
        // target rate — the exact shape we want in the ring.
        let mono: Vec<f32> = pcm_24k.iter().map(|&s| s as f32 / 32768.0).collect();
        let mut out = Vec::new();
        self.resampler.process(&mono, &mut out);
        let mut ring = self.ring.lock().unwrap();
        ring.extend(out);
        while ring.len() > self.max_samples {
            ring.pop_front();
        }
    }
}

/// Owns the running output stream (on its own thread, since a cpal stream is
/// `!Send` on macOS). Dropping it — or calling [`PlaybackHandle::stop`] — clears
/// the gate and joins the thread, releasing the device.
pub struct PlaybackHandle {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PlaybackHandle {
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

impl Drop for PlaybackHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open `device_name` (or the default output) and start playing whatever the
/// returned [`PlaybackSink`] is fed. Returns the sink + a handle that keeps the
/// stream alive until dropped.
pub fn start_playback(device_name: Option<String>) -> Result<(PlaybackSink, PlaybackHandle)> {
    // Probe the device rate on this thread so the sink's resampler targets it;
    // the stream itself is (re)opened inside the playback thread (a cpal Stream
    // is !Send on macOS, so it must live entirely on one thread — mirrors the
    // capture side in microphone.rs).
    let device_rate = probe_output_rate(device_name.as_deref())?;

    let ring = Arc::new(Mutex::new(VecDeque::<i16>::new()));
    let running = Arc::new(AtomicBool::new(true));

    let ring_thread = ring.clone();
    let running_thread = running.clone();
    let name_thread = device_name.clone();
    let thread = std::thread::spawn(move || {
        if let Err(e) = run_output(name_thread, ring_thread, running_thread) {
            log::warn!("[playback] output stream stopped: {e}");
        }
    });

    let sink = PlaybackSink {
        ring,
        resampler: LinearResampler::new(TRANSLATE_OUTPUT_RATE, device_rate),
        max_samples: device_rate as usize * 2,
    };
    Ok((sink, PlaybackHandle {
        running,
        thread: Some(thread),
    }))
}

/// Resolve the requested output device (by name, else default) and read its
/// default output sample rate.
fn probe_output_rate(device_name: Option<&str>) -> Result<u32> {
    let host = cpal::default_host();
    let device = pick_output_device(&host, device_name)?;
    let cfg = device.default_output_config()?;
    Ok(cfg.sample_rate().0)
}

fn pick_output_device(host: &cpal::Host, device_name: Option<&str>) -> Result<cpal::Device> {
    match device_name.filter(|n| !n.is_empty()) {
        Some(want) => host
            .output_devices()
            .ok()
            .and_then(|mut ds| ds.find(|d| d.name().map(|n| n == want).unwrap_or(false)))
            .or_else(|| host.default_output_device())
            .ok_or_else(|| anyhow!("no output device matching {want:?}")),
        None => host
            .default_output_device()
            .ok_or_else(|| anyhow!("no default output device")),
    }
}

fn run_output(
    device_name: Option<String>,
    ring: Arc<Mutex<VecDeque<i16>>>,
    running: Arc<AtomicBool>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = pick_output_device(&host, device_name.as_deref())?;
    let default_cfg = device.default_output_config()?;
    let sample_format = default_cfg.sample_format();
    let config: cpal::StreamConfig = default_cfg.into();
    let channels = config.channels as usize;

    log::info!(
        "[playback] playing on {:?} @ {} Hz, {} ch ({:?})",
        device.name().unwrap_or_default(),
        config.sample_rate.0,
        channels,
        sample_format
    );

    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_output_stream::<f32>(&device, &config, channels, ring)?,
        cpal::SampleFormat::I16 => build_output_stream::<i16>(&device, &config, channels, ring)?,
        cpal::SampleFormat::U16 => build_output_stream::<u16>(&device, &config, channels, ring)?,
        other => return Err(anyhow!("unsupported output sample format: {other:?}")),
    };
    stream.play()?;

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream);
    Ok(())
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    ring: Arc<Mutex<VecDeque<i16>>>,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<i16>,
{
    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            let mut ring = ring.lock().unwrap();
            let frames = data.len() / channels.max(1);
            for f in 0..frames {
                // One mono sample fanned out to every channel; silence
                // (equilibrium) when the buffer has run dry.
                let val = match ring.pop_front() {
                    Some(s) => T::from_sample(s),
                    None => T::EQUILIBRIUM,
                };
                for c in 0..channels {
                    data[f * channels + c] = val;
                }
            }
        },
        |e| log::warn!("[playback] stream error: {e}"),
        None,
    )?;
    Ok(stream)
}
