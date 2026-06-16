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

impl AudioSource for Microphone {
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let device_name = self.device_name.clone();
        let handle = std::thread::spawn(move || {
            if let Err(e) = run(device_name, tx, running) {
                eprintln!("[mic] capture stopped: {e}");
            }
        });
        Ok(handle)
    }
}

fn run(
    device_name: Option<String>,
    tx: UnboundedSender<Vec<i16>>,
    running: Arc<AtomicBool>,
) -> Result<()> {
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

    eprintln!(
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

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream);
    Ok(())
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
        |e| eprintln!("[mic] stream error: {e}"),
        None,
    )?;
    Ok(stream)
}
