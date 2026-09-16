use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use tokio::sync::mpsc::UnboundedSender;

use super::resample::LinearResampler;
use super::{AudioSource, TARGET_SAMPLE_RATE};

/// List the names of available input devices, for the Settings picker.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let mut names = Vec::new();
    if let Ok(devices) = host.input_devices() {
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

/// Microphone capture ("me"). Uses the named input device, or the system
/// default when `device_name` is `None`/empty.
pub struct Microphone {
    pub device_name: Option<String>,
}

/// How long [`Microphone::start`] waits for the capture thread's verdict on
/// opening the device. Opening takes a few milliseconds in practice, and a
/// device that cannot be opened at all fails immediately — so this grace is
/// only ever burned in full by a driver that wedges mid-open, where blocking
/// `start_meeting` (a main-thread command) any longer would freeze the UI.
const OPEN_VERDICT_GRACE: Duration = Duration::from_millis(1500);

impl AudioSource for Microphone {
    /// The device can only be opened on the thread that will own it — the cpal
    /// stream is `!Send` on macOS — which is why the verdict has to come back
    /// over a channel instead of `start` opening the device itself.
    ///
    /// Reporting it at all is the point: `start` used to return `Ok`
    /// unconditionally and leave the real failure to an `eprintln!` that a
    /// release build has no console for. A Windows user with mic access denied
    /// (or the device held by another app) got the LIVE badge, a ticking clock,
    /// a whole meeting of nothing, and not one line in `parley.log` about it.
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let device_name = self.device_name.clone();
        let (verdict_tx, verdict_rx) = std::sync::mpsc::channel::<Result<()>>();
        let handle = std::thread::spawn(move || match open(device_name, tx) {
            Ok(stream) => {
                let _ = verdict_tx.send(Ok(()));
                capture_until_stopped(stream, running);
            }
            // Logged here as well as sent: past the grace below nobody is
            // listening on the channel any more, and the device's own reason is
            // the one thing support needs out of a silent meeting.
            Err(e) => {
                log::error!("[mic] could not open the input device: {e}");
                let _ = verdict_tx.send(Err(e));
            }
        });
        match verdict_rx.recv_timeout(OPEN_VERDICT_GRACE) {
            Ok(Ok(())) => Ok(handle),
            Ok(Err(e)) => Err(e),
            // A slow open gets the benefit of the doubt — the thread is still
            // working on it and will log either way. Failing here instead would
            // abort a meeting over a merely sluggish USB or Bluetooth device.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("[mic] device open exceeded {OPEN_VERDICT_GRACE:?}; assuming it opens");
                Ok(handle)
            }
            // The thread ended without a verdict, i.e. it panicked inside
            // `open`. Nothing is capturing, so this must not read as success.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(anyhow!(
                "microphone capture thread ended before the device opened"
            )),
        }
    }
}

/// Open the requested input device and start its stream. Everything that can
/// fail about a microphone happens in here, so the verdict [`Microphone::start`]
/// waits on carries a real reason. The returned stream must stay on the calling
/// thread — it is `!Send` on macOS.
fn open(device_name: Option<String>, tx: UnboundedSender<Vec<i16>>) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    // Select the requested device by name, else fall back to the default.
    let device = match device_name.as_deref().filter(|n| !n.is_empty()) {
        Some(want) => host
            .input_devices()
            .ok()
            .and_then(|mut ds| ds.find(|d| d.name().map(|n| n == want).unwrap_or(false)))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow!("no input device matching {want:?}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| anyhow!("no default input device"))?,
    };
    let default_cfg = device.default_input_config()?;
    let sample_format = default_cfg.sample_format();
    let config: cpal::StreamConfig = default_cfg.into();
    let channels = config.channels as usize;
    let in_rate = config.sample_rate.0;

    log::info!(
        "[mic] capturing on {:?} @ {} Hz, {} ch ({:?}) → {} Hz mono",
        device.name().unwrap_or_default(),
        in_rate,
        channels,
        sample_format,
        TARGET_SAMPLE_RATE
    );

    // The cpal stream is !Send on macOS, so it lives entirely on this thread.
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, channels, in_rate, tx)?,
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, channels, in_rate, tx)?,
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, channels, in_rate, tx)?,
        other => return Err(anyhow!("unsupported sample format: {other:?}")),
    };
    stream.play()?;
    Ok(stream)
}

/// Hold an opened device until the session's gate clears, then release it.
fn capture_until_stopped(stream: cpal::Stream, running: Arc<AtomicBool>) {
    // Poll the gate tightly so the stream (and the device) is released within a
    // few ms of stop — voice typing cuts on release and a lingering device would
    // keep feeding the next moments of audio. A 10 ms tick is negligible CPU.
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(stream);
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    in_rate: u32,
    tx: UnboundedSender<Vec<i16>>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut resampler = LinearResampler::new(in_rate, TARGET_SAMPLE_RATE);
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Downmix interleaved frames to mono f32.
            let frames = data.len() / channels.max(1);
            let mut mono = Vec::with_capacity(frames);
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += f32::from_sample(data[f * channels + c]);
                }
                mono.push(acc / channels as f32);
            }
            let mut out = Vec::new();
            resampler.process(&mono, &mut out);
            if !out.is_empty() {
                let _ = tx.send(out);
            }
        },
        // A device lost or reconfigured mid-meeting surfaces only here, and the
        // capture keeps "running" (silently) afterwards — so this has to reach
        // `parley.log`, the one place a support request can read it back from.
        |e| log::error!("[mic] stream error, capture may have dropped: {e}"),
        None,
    )?;
    Ok(stream)
}
