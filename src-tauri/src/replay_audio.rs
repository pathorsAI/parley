//! Self-contained audio compression for the replay upload flow.
//!
//! Before a recording is uploaded to Soniox's async API we shrink it: decode
//! whatever container/codec the user handed us (mp3, m4a/aac, flac, wav, ogg,
//! alac, …) with [`symphonia`], downmix to mono, resample to 16 kHz, then
//! re-encode as Opus inside an Ogg container at ~24 kbps. Speech transcription
//! needs nothing more than 16 kHz mono, so this is a large bandwidth win with no
//! meaningful accuracy cost.
//!
//! Everything here is pure Rust compiled into the app — `audiopus_sys` builds
//! libopus statically, so there is no external ffmpeg/sidecar/binary dependency
//! and nothing for the user to install. Licenses are clean: symphonia (MPL-2.0),
//! libopus via audiopus_sys (BSD/ISC), the `ogg` crate (Apache-2.0/MIT).
//!
//! The single entry point is [`compress_for_upload`]; the caller treats any
//! `Err` as "just upload the original file" so compression can never block an
//! upload.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use audiopus::{
    coder::{Decoder, Encoder},
    Application, Bitrate, Channels, SampleRate,
};
use ogg::PacketWriteEndInfo;
use symphonia::core::audio::AudioBufferRef;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::audio::resample::LinearResampler;

/// Target rate for the compressed output (also what the realtime path uses).
const TARGET_RATE: u32 = 16_000;
/// Opus encode bitrate — ~24 kbps is ample for 16 kHz mono speech.
const OPUS_BITRATE: i32 = 24_000;
/// 20 ms frame at 16 kHz = 320 samples. Opus only accepts fixed frame sizes.
const FRAME_SAMPLES: usize = (TARGET_RATE as usize / 1000) * 20;
/// Opus granule positions are always counted at 48 kHz; a 20 ms frame advances
/// 960 samples there (48000 / 1000 * 20).
const GRANULE_PER_FRAME: u64 = 960;
/// Per the Opus spec the encoder introduces 3.84 ms of look-ahead delay at
/// 48 kHz = ~312 samples of pre-skip. libopus reports the exact value via a CTL;
/// we use the conventional default so decoders trim the right amount.
const PRE_SKIP: u16 = 312;

/// Decoded mono audio plus the source sample rate.
struct DecodedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
}

/// Compress `input` to a temporary Opus-in-Ogg file (16 kHz mono, ~24 kbps) and
/// return its path. The caller owns the temp file and must delete it.
///
/// Returns `Err` if the input can't be decoded (unsupported codec, corrupt
/// data, encode failure, …) — callers fall back to uploading the raw file.
pub fn compress_for_upload(input: &Path) -> Result<PathBuf> {
    let decoded = decode_to_mono_f32(input)?;
    if decoded.samples.is_empty() {
        return Err(anyhow!("decoded audio was empty"));
    }

    // Resample mono f32 → 16 kHz i16 PCM using the shared linear resampler.
    let mut pcm16: Vec<i16> = Vec::new();
    let mut resampler = LinearResampler::new(decoded.sample_rate, TARGET_RATE);
    resampler.process(&decoded.samples, &mut pcm16);

    if pcm16.is_empty() {
        return Err(anyhow!("resampled audio was empty"));
    }

    let out_path = unique_temp_path();
    encode_opus_ogg(&pcm16, &out_path).context("Opus/Ogg encode failed")?;
    Ok(out_path)
}

/// Decode `input` to 16 kHz mono `f32` samples in [-1, 1] — the exact form the
/// speaker-embedding pipeline (and any kaldi-fbank front-end) expects.
///
/// Reuses the upload path's decode + linear resampler, then maps the resampled
/// `i16` PCM back to `f32` by dividing by 32768 (the same convention knf-rs's
/// `convert_integer_to_float_audio` uses), so callers get a single contiguous
/// buffer they can slice by timestamp. Decodes once; slicing is the caller's job.
pub fn decode_to_16k_mono(input: &Path) -> Result<Vec<f32>> {
    // Ogg-Opus (the app's own recordings + many uploads): symphonia demuxes Ogg
    // but ships no Opus decoder, so decode the packets with libopus directly to
    // 16 kHz mono (no resample step needed).
    if is_ogg_opus(input)? {
        return decode_ogg_opus_16k_mono(input);
    }
    let decoded = decode_to_mono_f32(input)?;
    if decoded.samples.is_empty() {
        return Err(anyhow!("decoded audio was empty"));
    }
    let mut pcm16: Vec<i16> = Vec::new();
    let mut resampler = LinearResampler::new(decoded.sample_rate, TARGET_RATE);
    resampler.process(&decoded.samples, &mut pcm16);
    Ok(pcm16.into_iter().map(|s| s as f32 / 32768.0).collect())
}

/// Sniff whether `input` is an Ogg stream carrying Opus: the `OggS` capture
/// pattern plus an `OpusHead` identification header in the first page. symphonia
/// can demux Ogg but has no Opus *decoder*, so these take the libopus path below.
fn is_ogg_opus(input: &Path) -> Result<bool> {
    let mut f = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let mut buf = [0u8; 128];
    let n = f.read(&mut buf)?;
    let head = &buf[..n];
    Ok(head.starts_with(b"OggS") && head.windows(8).any(|w| w == b"OpusHead"))
}

/// Decode an Ogg-Opus file straight to 16 kHz mono `f32` using libopus: the `ogg`
/// crate demuxes pages → packets and the Opus decoder is created at 16 kHz mono
/// so it downmixes + outputs the target rate directly. The two header packets
/// (`OpusHead`/`OpusTags`) are skipped; a corrupt audio packet is skipped rather
/// than aborting the whole decode.
fn decode_ogg_opus_16k_mono(input: &Path) -> Result<Vec<f32>> {
    let file = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let mut reader = ogg::reading::PacketReader::new(BufReader::new(file));
    let mut decoder = Decoder::new(SampleRate::Hz16000, Channels::Mono)
        .map_err(|e| anyhow!("opus decoder init: {e}"))?;
    let mut samples: Vec<f32> = Vec::new();
    // 120 ms is the largest Opus packet duration; 16 kHz mono → 1920 samples (+ margin).
    let mut frame = vec![0i16; 2880];
    while let Some(packet) = reader.read_packet().context("read ogg packet")? {
        let data = &packet.data;
        if data.is_empty() || data.starts_with(b"OpusHead") || data.starts_with(b"OpusTags") {
            continue;
        }
        match decoder.decode(Some(&data[..]), &mut frame[..], false) {
            Ok(n) => samples.extend(frame[..n].iter().map(|&s| s as f32 / 32768.0)),
            Err(_) => continue,
        }
    }
    if samples.is_empty() {
        return Err(anyhow!("decoded Opus audio was empty"));
    }
    Ok(samples)
}

/// Decode the default audio track of `input` into interleaved-then-downmixed
/// mono `f32` samples. Captures the source sample rate (channel count is folded
/// away by the downmix).
fn decode_to_mono_f32(input: &Path) -> Result<DecodedAudio> {
    let file = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Hint the prober with the file extension when present — it only speeds up
    // format detection; symphonia still probes the actual bytes.
    let mut hint = Hint::new();
    if let Some(ext) = input.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("unsupported or unrecognized audio container")?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no decodable audio track"))?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("no decoder for this codec")?;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_rate: u32 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean end of stream (symphonia surfaces EOF as an IO error).
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => {
                // Track list changed mid-stream; for our single-track inputs we
                // just stop here rather than re-initialize.
                break;
            }
            Err(e) => return Err(anyhow!("decode error: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(buf) => {
                if sample_rate == 0 {
                    sample_rate = buf.spec().rate;
                }
                downmix_into(&buf, &mut samples);
            }
            // Recoverable decode hiccups: skip the packet, keep going.
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(symphonia::core::errors::Error::IoError(_)) => break,
            Err(e) => return Err(anyhow!("decode error: {e}")),
        }
    }

    if sample_rate == 0 {
        return Err(anyhow!("could not determine source sample rate"));
    }

    Ok(DecodedAudio {
        samples,
        sample_rate,
    })
}

/// Average all channels of a decoded buffer into mono `f32` (range ~[-1, 1]),
/// appending to `out`. Handles every sample format symphonia can produce by
/// going through its `f32`-normalizing conversion.
fn downmix_into(buf: &AudioBufferRef<'_>, out: &mut Vec<f32>) {
    // Convert whatever the native sample format is into an f32 planar buffer.
    let spec = *buf.spec();
    let channels = spec.channels.count();
    let frames = buf.frames();
    if channels == 0 || frames == 0 {
        return;
    }

    let mut sample_buf = symphonia::core::audio::SampleBuffer::<f32>::new(frames as u64, spec);
    sample_buf.copy_interleaved_ref(buf.clone());
    let interleaved = sample_buf.samples();

    out.reserve(frames);
    for frame in 0..frames {
        let mut acc = 0.0f32;
        for ch in 0..channels {
            acc += interleaved[frame * channels + ch];
        }
        out.push(acc / channels as f32);
    }
}

/// Encode 16 kHz mono `pcm16` as Opus in an Ogg container, written to `out_path`.
/// `pub(crate)` so the live-meeting recorder can reuse it to persist a captured
/// session (the realtime path already produces 16 kHz mono PCM).
pub(crate) fn encode_opus_ogg(pcm16: &[i16], out_path: &Path) -> Result<()> {
    let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
        .map_err(|e| anyhow!("opus encoder init: {e}"))?;
    encoder
        .set_bitrate(Bitrate::BitsPerSecond(OPUS_BITRATE))
        .map_err(|e| anyhow!("opus set_bitrate: {e}"))?;

    let out_file = File::create(out_path)
        .with_context(|| format!("create temp output {}", out_path.display()))?;
    let mut writer = ogg::PacketWriter::new(std::io::BufWriter::new(out_file));

    // A single logical Ogg stream; the serial just needs to be unique per file.
    let serial: u32 = rand_serial();

    // Page 1: the OpusHead identification header (must be its own page).
    let head = build_opus_head();
    writer
        .write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusHead")?;

    // Page 2: the OpusTags comment header (its own page, granule 0).
    let tags = build_opus_tags();
    writer
        .write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusTags")?;

    // Audio pages: one Opus packet per 20 ms frame, granule counted at 48 kHz.
    let mut granule: u64 = 0;
    let total_frames = pcm16.len().div_ceil(FRAME_SAMPLES);
    let mut encode_buf = vec![0u8; 4000]; // max Opus packet for a 20ms frame

    for (idx, chunk) in pcm16.chunks(FRAME_SAMPLES).enumerate() {
        // Opus requires a full frame; zero-pad the final partial frame.
        let mut frame = [0i16; FRAME_SAMPLES];
        frame[..chunk.len()].copy_from_slice(chunk);

        let n = encoder
            .encode(&frame, &mut encode_buf)
            .map_err(|e| anyhow!("opus encode: {e}"))?;
        granule += GRANULE_PER_FRAME;

        let is_last = idx + 1 == total_frames;
        let end_info = if is_last {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };

        writer
            .write_packet(encode_buf[..n].to_vec(), serial, end_info, granule)
            .context("write Opus audio packet")?;
    }

    Ok(())
}

/// Build the `OpusHead` identification header packet (19 bytes, mapping family 0).
fn build_opus_head() -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channel count (mono)
    head.extend_from_slice(&PRE_SKIP.to_le_bytes()); // pre-skip
    head.extend_from_slice(&TARGET_RATE.to_le_bytes()); // input sample rate (16 kHz)
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain (Q7.8), 0 dB
    head.push(0); // channel mapping family 0
    head
}

/// Build the `OpusTags` comment header packet: vendor string + zero comments.
fn build_opus_tags() -> Vec<u8> {
    let vendor = b"parley";
    let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // comment list length = 0
    tags
}

/// A unique temp path for the compressed output.
fn unique_temp_path() -> PathBuf {
    std::env::temp_dir().join(format!("parley-compressed-{}.ogg", uuid::Uuid::new_v4()))
}

/// A unique temp path for a freshly encoded live recording. The caller (stop
/// meeting) hands this path to `save_history_entry`, which moves it into the
/// entry folder, so it only ever lives in the temp dir briefly.
pub(crate) fn unique_recording_path() -> PathBuf {
    std::env::temp_dir().join(format!("parley-recording-{}.ogg", uuid::Uuid::new_v4()))
}

/// A pseudo-unique Ogg stream serial derived from a fresh UUID.
fn rand_serial() -> u32 {
    let b = uuid::Uuid::new_v4().into_bytes();
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// Synthesize a WAV with ffmpeg, compress it, and validate the output with
    /// ffprobe/ffmpeg (used purely as a test oracle — never by the app).
    ///
    /// Exercises several Symphonia decoders (wav/pcm, mp3, m4a/aac) and proves
    /// each produces valid, much-smaller Opus/Ogg that ffmpeg decodes cleanly.
    #[test]
    fn compress_produces_valid_opus_ogg() {
        // Synthesize a stereo 44.1 kHz, 5s WAV; bail (skip) if ffmpeg is absent.
        let dir = std::env::temp_dir();
        let wav = dir.join(format!("parley-test-{}.wav", uuid::Uuid::new_v4()));
        let made = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-ac",
                "2",
                "-ar",
                "44100",
                wav.to_str().unwrap(),
            ])
            .status();
        let Ok(status) = made else {
            eprintln!("ffmpeg not available; skipping oracle validation");
            return;
        };
        assert!(status.success(), "ffmpeg failed to synthesize test wav");

        // Derive mp3 + m4a variants to cover more decoders.
        let mp3 = dir.join(format!("parley-test-{}.mp3", uuid::Uuid::new_v4()));
        let m4a = dir.join(format!("parley-test-{}.m4a", uuid::Uuid::new_v4()));
        for (out, args) in [(&mp3, ["-c:a", "libmp3lame"]), (&m4a, ["-c:a", "aac"])] {
            let ok = Command::new("ffmpeg")
                .args(["-y", "-i", wav.to_str().unwrap()])
                .args(args)
                .arg(out.to_str().unwrap())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "ffmpeg failed to make {}", out.display());
        }

        let wav_size = std::fs::metadata(&wav).unwrap().len();
        for input in [&wav, &mp3, &m4a] {
            let out = compress_for_upload(input).expect("compression should succeed");
            validate_opus_ogg(&out, wav_size);
            let _ = std::fs::remove_file(&out);
        }

        for f in [&wav, &mp3, &m4a] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// Assert `out` is valid Opus/Ogg: ffprobe sees opus + mono, the OpusHead
    /// declares 16 kHz input, ffmpeg decodes it with no errors, and it's far
    /// smaller than the reference WAV.
    fn validate_opus_ogg(out: &Path, ref_wav_size: u64) {
        let ogg_size = std::fs::metadata(out).unwrap().len();
        eprintln!(
            "ref_wav={ref_wav_size} bytes, ogg={ogg_size} bytes ({})",
            out.display()
        );
        assert!(ogg_size * 4 < ref_wav_size, "output should be much smaller");

        // ffprobe: opus + mono. (Opus stream sample_rate is ALWAYS 48000 by
        // spec — Opus decodes internally at 48 kHz regardless of source — so the
        // real 16 kHz lives in the OpusHead input_sample_rate field, checked
        // below rather than via ffprobe's stream rate.)
        let probe = Command::new("ffprobe")
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,sample_rate,channels,duration",
                "-of",
                "default=nw=1",
                out.to_str().unwrap(),
            ])
            .output()
            .expect("ffprobe");
        let info = String::from_utf8_lossy(&probe.stdout);
        eprintln!("ffprobe:\n{info}");
        assert!(info.contains("codec_name=opus"), "expected opus: {info}");
        assert!(info.contains("channels=1"), "expected mono: {info}");

        // OpusHead input_sample_rate (LE u32 at offset 12) must be 16000.
        let bytes = std::fs::read(out).unwrap();
        let pos = find_subslice(&bytes, b"OpusHead").expect("OpusHead present");
        let rate = u32::from_le_bytes([
            bytes[pos + 12],
            bytes[pos + 13],
            bytes[pos + 14],
            bytes[pos + 15],
        ]);
        assert_eq!(rate, 16000, "OpusHead input_sample_rate should be 16000");

        // ffmpeg must decode it cleanly (empty stderr at error level).
        let decode = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-i",
                out.to_str().unwrap(),
                "-f",
                "null",
                "-",
            ])
            .output()
            .expect("ffmpeg decode");
        let errs = String::from_utf8_lossy(&decode.stderr);
        assert!(errs.trim().is_empty(), "ffmpeg decode errors: {errs}");
    }
}
