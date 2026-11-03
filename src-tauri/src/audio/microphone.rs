use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

/// The stream callback's PCM sender, shared with the capture thread so the
/// stop can drop it itself. Dropping the `cpal::Stream` is not enough on macOS:
/// for a device picked by name (the Settings picker), cpal 0.15's disconnect
/// listener holds a clone of the stream inside the stream, so the drop frees
/// nothing — the AudioUnit keeps running and its
/// callback keeps this sender alive for the life of the app. Every meeting and
/// every dictation left its microphone open that way, and each leaked one fed
/// the next meeting's recording another copy of the room
/// (pathorsAI/parley#660).
type SenderSlot = Arc<Mutex<Option<UnboundedSender<Vec<i16>>>>>;

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
        let slot: SenderSlot = Arc::new(Mutex::new(Some(tx)));
        let handle = std::thread::spawn(move || match open(device_name, slot.clone()) {
            Ok(stream) => {
                let _ = verdict_tx.send(Ok(()));
                capture_until_stopped(stream, running, &slot);
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
fn open(device_name: Option<String>, tx: SenderSlot) -> Result<cpal::Stream> {
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

/// Hold an opened device until the session's gate clears, then release it:
/// stop the AudioUnit and drop the sender explicitly (see [`SenderSlot`]), so
/// the device goes quiet and the PCM channel closes whatever cpal leaks.
fn capture_until_stopped(stream: cpal::Stream, running: Arc<AtomicBool>, tx: &SenderSlot) {
    // Poll the gate tightly so the stream (and the device) is released within a
    // few ms of stop — voice typing cuts on release and a lingering device would
    // keep feeding the next moments of audio. A 10 ms tick is negligible CPU.
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if let Err(e) = stream.pause() {
        log::warn!("[mic] stopping the input stream failed: {e}");
    }
    tx.lock().unwrap().take();
    drop(stream);
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    in_rate: u32,
    tx: SenderSlot,
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
            if out.is_empty() {
                return;
            }
            if let Some(tx) = tx.lock().unwrap().as_ref() {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a real input device (and mic permission), so it only runs on
    /// request: `cargo test --lib microphone -- --ignored`.
    #[test]
    #[ignore]
    fn a_stopped_capture_closes_its_pcm_channel() {
        // A device picked by name, as the Settings picker does: only then does
        // cpal install the disconnect listener that leaked the stream.
        let device_name = list_input_devices().into_iter().next();
        assert!(device_name.is_some(), "no input device to test with");
        let running = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let handle = Microphone { device_name }
            .start(tx, running.clone())
            .expect("open the default input device");
        std::thread::sleep(Duration::from_millis(500));
        running.store(false, Ordering::SeqCst);
        handle.join().unwrap();
        // Whatever was captured before the stop drains; then the channel ends.
        // With cpal holding the sender past the drop, it never did.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match rx.try_recv() {
                Ok(_) => continue,
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the stopped microphone still holds its sender"
                    );
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }
}
