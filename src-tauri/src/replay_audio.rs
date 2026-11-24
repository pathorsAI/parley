//! Self-contained audio compression for the replay upload flow.
//!
//! Before a recording is uploaded for batch transcription we shrink it: decode
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
//! The entry point is [`compress_for_upload`] ([`compress_for_upload_split`]
//! cuts a long recording into equal parts); the caller treats any `Err` as
//! "just upload the original file" so compression can never block an upload.
//! Everything streams — decode, downmix, resample and encode one packet at a
//! time ([`stream_16k_mono_i16`], [`OpusOggWriter`]) — so memory stays flat
//! however long the recording is.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use audiopus::{
    coder::{Decoder, Encoder},
    Application, Bitrate, Channels, SampleRate,
};
use ogg::PacketWriteEndInfo;
use serde::Serialize;
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
pub(crate) const OPUS_BITRATE: i32 = 24_000;
/// 20 ms frame at 16 kHz = 320 samples. Opus only accepts fixed frame sizes.
pub(crate) const FRAME_SAMPLES: usize = (TARGET_RATE as usize / 1000) * 20;
/// Opus granule positions are always counted at 48 kHz; a 20 ms frame advances
/// 960 samples there (48000 / 1000 * 20).
pub(crate) const GRANULE_PER_FRAME: u64 = 960;
/// Per the Opus spec the encoder introduces 3.84 ms of look-ahead delay at
/// 48 kHz = ~312 samples of pre-skip. libopus reports the exact value via a CTL;
/// we use the conventional default so decoders trim the right amount.
const PRE_SKIP: u16 = 312;

/// Compress `input` to a temporary Opus-in-Ogg file (16 kHz mono, ~24 kbps) and
/// return its path. The caller owns the temp file and must delete it.
///
/// Streams: the source is decoded packet by packet, downmixed, resampled and
/// encoded as it goes, so memory stays flat however long the recording is (it
/// used to hold the whole decode, ~0.8 GB per hour of 48 kHz audio, and long
/// imports ran the app out of memory).
///
/// Returns `Err` if the input can't be decoded (unsupported codec, corrupt
/// data, encode failure, …) — callers fall back to uploading the raw file.
pub fn compress_for_upload(input: &Path) -> Result<PathBuf> {
    let mut parts = write_parts(input, None, 1, unique_temp_path)?;
    parts
        .pop()
        .map(|(path, _)| path)
        .ok_or_else(|| anyhow!("resampled audio was empty"))
}

/// Compress `input` like [`compress_for_upload`], cut into `parts` equal pieces,
/// each its own Opus/Ogg temp file (in order). The cut points are sample offsets
/// at 16 kHz from the container's declared duration ([`probe_audio`]); the last
/// part takes whatever remains, so a slightly wrong declared duration only moves
/// the last part's length. Fails when the duration is unknown. The caller owns
/// the files ([`discard_part`] deletes one).
pub fn compress_for_upload_split(input: &Path, parts: usize) -> Result<Vec<PathBuf>> {
    let parts = parts.max(1);
    let duration_ms = probe_audio(input)?
        .duration_ms
        .ok_or_else(|| anyhow!("the recording's length is unknown, so it can't be split"))?;
    let part_len = equal_part_samples(duration_ms, parts);
    Ok(write_parts(input, Some(part_len), parts, unique_part_path)?
        .into_iter()
        .map(|(path, _)| path)
        .collect())
}

/// Samples (at 16 kHz) in each of `parts` equal parts of `duration_ms`.
fn equal_part_samples(duration_ms: u64, parts: usize) -> u64 {
    let total = duration_ms * (u64::from(TARGET_RATE) / 1000);
    total.div_ceil(parts as u64).max(FRAME_SAMPLES as u64)
}

/// Stream `input` into Opus/Ogg files: one when `part_len` is `None`, else a new
/// file every `part_len` samples up to `max_parts` (the last takes the rest).
/// Returns each file with the samples it holds. On any error every file written
/// so far is deleted.
fn write_parts(
    input: &Path,
    part_len: Option<u64>,
    max_parts: usize,
    path_for: fn() -> PathBuf,
) -> Result<Vec<(PathBuf, u64)>> {
    let mut parts = PartWriter {
        part_len,
        max_parts,
        path_for,
        done: Vec::new(),
        current: None,
    };
    let streamed = stream_16k_mono_i16(input, &mut |pcm| parts.write(pcm));
    match streamed.and_then(|_| parts.finish_current()) {
        Ok(()) => Ok(parts.done),
        Err(e) => {
            parts.discard();
            Err(e)
        }
    }
}

/// Where [`write_parts`] sends the streamed PCM: the part being written, and
/// the finished ones.
struct PartWriter {
    part_len: Option<u64>,
    max_parts: usize,
    path_for: fn() -> PathBuf,
    done: Vec<(PathBuf, u64)>,
    current: Option<(PathBuf, OpusOggWriter, u64)>,
}

impl PartWriter {
    fn parts_started(&self) -> usize {
        self.done.len() + usize::from(self.current.is_some())
    }

    /// The samples the current part may still take; unbounded for the last one.
    fn room(&self, in_part: u64) -> u64 {
        match self.part_len {
            Some(len) if self.parts_started() < self.max_parts => len - in_part,
            _ => u64::MAX,
        }
    }

    fn write(&mut self, mut pcm: &[i16]) -> Result<()> {
        while !pcm.is_empty() {
            if self.current.is_none() {
                let path = (self.path_for)();
                let writer = OpusOggWriter::create(&path).context("Opus/Ogg encode failed")?;
                self.current = Some((path, writer, 0));
            }
            let in_part = self.current.as_ref().map_or(0, |c| c.2);
            let take = usize::try_from(self.room(in_part))
                .unwrap_or(usize::MAX)
                .min(pcm.len());
            let full = {
                let (_, writer, written) = self.current.as_mut().expect("opened above");
                writer
                    .write(&pcm[..take])
                    .context("Opus/Ogg encode failed")?;
                *written += take as u64;
                self.part_len == Some(*written) && self.parts_started() < self.max_parts
            };
            pcm = &pcm[take..];
            if full {
                self.finish_current()?;
            }
        }
        Ok(())
    }

    fn finish_current(&mut self) -> Result<()> {
        if let Some((path, writer, written)) = self.current.take() {
            // Push the path first so a failed finish still gets cleaned up.
            self.done.push((path, written));
            writer.finish().context("Opus/Ogg encode failed")?;
        }
        Ok(())
    }

    fn discard(&mut self) {
        if let Some((path, writer, _)) = self.current.take() {
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
        for (path, _) in self.done.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Decode `input` to 16 kHz mono `f32` samples in [-1, 1] — the exact form the
/// speaker-embedding pipeline (and any kaldi-fbank front-end) expects.
///
/// The streamed 16 kHz `i16` PCM of [`stream_16k_mono_i16`] mapped back to
/// `f32` by dividing by 32768 (the same convention knf-rs's
/// `convert_integer_to_float_audio` uses), so callers get a single contiguous
/// buffer they can slice by timestamp. Decodes once; slicing is the caller's job.
pub fn decode_to_16k_mono(input: &Path) -> Result<Vec<f32>> {
    let mut out: Vec<f32> = Vec::new();
    stream_16k_mono_i16(input, &mut |pcm| {
        out.extend(pcm.iter().map(|&s| f32::from(s) / 32768.0));
        Ok(())
    })?;
    Ok(out)
}

/// Measure the articulation rate of `input` without holding the recording: the
/// streamed 16 kHz PCM feeds [`crate::audio::prosody::SpeechRateStream`], which
/// returns exactly what the batch `measure_speech_rate_hz` would.
pub fn measure_speech_rate(input: &Path) -> Result<f32> {
    let mut meter = crate::audio::prosody::SpeechRateStream::new();
    let mut frame: Vec<f32> = Vec::new();
    stream_16k_mono_i16(input, &mut |pcm| {
        frame.clear();
        frame.extend(pcm.iter().map(|&s| f32::from(s) / 32768.0));
        meter.push(&frame);
        Ok(())
    })?;
    Ok(meter.rate_hz())
}

/// Decode `input` (anything [`decode_to_16k_mono`] reads: the app's Ogg/Opus
/// via libopus, everything else via symphonia) and write it to `out` as a plain
/// 16 kHz mono 16-bit PCM WAV.
///
/// The playback fallback: a webview that cannot decode a recording (an older
/// WebKit without Ogg/Opus, an odd container) can always play PCM WAV. Written
/// to a sibling `.part` file and renamed into place, so a reader never sees a
/// half-written file under the final name. The `.part` name is unique per call
/// (`<out>.<uuid>.part`), so two decodes into the same `out` never write — or
/// rename — each other's file.
pub fn transcode_to_wav_16k_mono(input: &Path, out: &Path) -> Result<()> {
    let samples = decode_to_16k_mono(input)?;
    let part = part_path(out);
    let written = write_wav_16k_mono(&samples, &part).and_then(|()| {
        std::fs::rename(&part, out).with_context(|| format!("rename {}", part.display()))
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    written
}

/// A fresh temp name next to `out` for one write: `<name>.<uuid>.part`.
fn part_path(out: &Path) -> PathBuf {
    let mut name = out.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.part", uuid::Uuid::new_v4().simple()));
    out.with_file_name(name)
}

/// Write `samples` (16 kHz mono, `f32` in [-1, 1]) as a 16-bit PCM WAV file.
pub(crate) fn write_wav_16k_mono(samples: &[f32], out: &Path) -> Result<()> {
    let data_len = samples
        .len()
        .checked_mul(2)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n <= u32::MAX - 36)
        .ok_or_else(|| anyhow!("audio is too long for a WAV file"))?;
    let file = File::create(out).with_context(|| format!("create {}", out.display()))?;
    let mut w = BufWriter::new(file);
    w.write_all(&wav_header(TARGET_RATE, 1, data_len))?;
    for &s in samples {
        // The inverse of decode_to_16k_mono's i16 → f32 mapping (÷ 32768).
        let v = (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
        w.write_all(&v.to_le_bytes())?;
    }
    w.flush().context("flush WAV")?;
    Ok(())
}

/// The 44-byte canonical RIFF/WAVE header for 16-bit PCM.
fn wav_header(sample_rate: u32, channels: u16, data_len: u32) -> [u8; 44] {
    const BITS: u16 = 16;
    let block_align = channels * (BITS / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&BITS.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// The first bytes of `input`: enough for the first Ogg page's `OpusHead`.
fn read_head(input: &Path) -> Result<Vec<u8>> {
    let mut f = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let mut buf = [0u8; 128];
    let n = f.read(&mut buf)?;
    Ok(buf[..n].to_vec())
}

/// Where the `OpusHead` packet starts in an Ogg/Opus file's first bytes.
fn opus_head_at(head: &[u8]) -> Option<usize> {
    if !head.starts_with(b"OggS") {
        return None;
    }
    head.windows(8).position(|w| w == b"OpusHead")
}

/// Sniff whether `input` is an Ogg stream carrying Opus: the `OggS` capture
/// pattern plus an `OpusHead` identification header in the first page. symphonia
/// can demux Ogg but has no Opus *decoder*, so these take the libopus path below.
fn is_ogg_opus(input: &Path) -> Result<bool> {
    Ok(opus_head_at(&read_head(input)?).is_some())
}

/// What the import wizard needs to know about a file before any heavy work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    /// From the container's metadata (no decode); `None` when it doesn't say.
    pub duration_ms: Option<u64>,
    /// Whether [`compress_for_upload`] can decode this codec at all.
    pub compressible: bool,
    /// The file's size on disk.
    pub bytes: u64,
}

/// Read `input`'s duration and codec support from its headers, without
/// decoding: Ogg/Opus from the last page's granule position, anything else
/// from symphonia's track parameters. A container symphonia can't read
/// (webm, wma) is reported as not compressible with an unknown duration.
pub fn probe_audio(input: &Path) -> Result<AudioProbe> {
    let bytes = std::fs::metadata(input)
        .with_context(|| format!("stat {}", input.display()))?
        .len();
    let head = read_head(input)?;
    if let Some(at) = opus_head_at(&head) {
        let pre_skip = head
            .get(at + 10..at + 12)
            .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]));
        return Ok(AudioProbe {
            duration_ms: ogg_last_granule(input)?
                .map(|g| g.saturating_sub(u64::from(pre_skip)) * 1000 / 48_000),
            compressible: true,
            bytes,
        });
    }
    let Ok((format, _decoder, track_id)) = open_symphonia(input) else {
        return Ok(AudioProbe {
            duration_ms: None,
            compressible: false,
            bytes,
        });
    };
    let duration_ms = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .and_then(|t| {
            let params = &t.codec_params;
            let frames = params.n_frames?;
            if let Some(tb) = params.time_base {
                let time = tb.calc_time(frames);
                Some(time.seconds * 1000 + (time.frac * 1000.0) as u64)
            } else {
                let rate = u64::from(params.sample_rate?);
                (rate > 0).then(|| frames * 1000 / rate)
            }
        });
    Ok(AudioProbe {
        duration_ms,
        compressible: true,
        bytes,
    })
}

/// The granule position of the last complete Ogg page of `input` (Opus counts
/// it at 48 kHz). Reads only the file's tail: a page is at most ~64 KiB.
fn ogg_last_granule(input: &Path) -> Result<Option<u64>> {
    use std::io::{Seek, SeekFrom};
    const TAIL: u64 = 128 * 1024;
    let mut f = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(TAIL);
    f.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut tail)?;
    Ok(last_granule_in(&tail))
}

/// The last valid granule position among the Ogg page headers in `bytes`.
/// A page header is 27 bytes plus a lacing table; a page whose header or body
/// runs past the end (a truncated write) is skipped, and so is the
/// "no packet ends here" granule (-1).
fn last_granule_in(bytes: &[u8]) -> Option<u64> {
    let mut found = None;
    let mut i = 0;
    while let Some(off) = bytes[i..].windows(4).position(|w| w == b"OggS") {
        let at = i + off;
        i = at + 4;
        let Some(header) = bytes.get(at..at + 27) else {
            break;
        };
        if header[4] != 0 {
            continue; // stream structure version is always 0
        }
        let segments = usize::from(header[26]);
        let Some(lacing) = bytes.get(at + 27..at + 27 + segments) else {
            break;
        };
        let body: usize = lacing.iter().map(|&b| usize::from(b)).sum();
        if at + 27 + segments + body > bytes.len() {
            break;
        }
        let granule = u64::from_le_bytes(header[6..14].try_into().expect("8 bytes"));
        if granule != u64::MAX {
            found = Some(granule);
        }
    }
    found
}

/// Whether `input` is already what [`compress_for_upload`] would produce: Ogg/
/// Opus, mono, a 16 kHz `OpusHead`, at no more than ~32 kbps (our own output,
/// a split part, the app's own recordings). Re-encoding such a file would only
/// lose quality and burn minutes of CPU, so the upload sends it as is.
pub fn is_upload_ready(input: &Path) -> bool {
    const MAX_BITS_PER_SEC: u64 = 32_000;
    let Ok(head) = read_head(input) else {
        return false;
    };
    let Some(at) = opus_head_at(&head) else {
        return false;
    };
    let channels = head.get(at + 9).copied();
    let rate = head
        .get(at + 12..at + 16)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if channels != Some(1) || rate != Some(TARGET_RATE) {
        return false;
    }
    match probe_audio(input) {
        Ok(AudioProbe {
            duration_ms: Some(ms),
            bytes,
            ..
        }) if ms > 0 => bytes * 8 * 1000 / ms <= MAX_BITS_PER_SEC,
        _ => false,
    }
}

/// Stream `input` to `sink` as 16 kHz mono `i16` PCM, a decoded packet at a
/// time, and return how many samples went out. Ogg/Opus decodes with libopus
/// (symphonia has no Opus decoder) straight to 16 kHz mono; everything else
/// decodes with symphonia, is downmixed and runs through the stateful
/// [`LinearResampler`], whose output is the same whether it sees the audio in
/// one call or packet by packet.
pub(crate) fn stream_16k_mono_i16(
    input: &Path,
    sink: &mut dyn FnMut(&[i16]) -> Result<()>,
) -> Result<u64> {
    if is_ogg_opus(input)? {
        stream_ogg_opus(input, sink)
    } else {
        stream_symphonia(input, sink)
    }
}

/// The Ogg/Opus arm of [`stream_16k_mono_i16`]: the `ogg` crate demuxes pages →
/// packets and the Opus decoder is created at 16 kHz mono so it downmixes and
/// outputs the target rate directly. The two header packets (`OpusHead`/
/// `OpusTags`) are skipped; a corrupt audio packet is skipped rather than
/// aborting the whole decode.
fn stream_ogg_opus(input: &Path, sink: &mut dyn FnMut(&[i16]) -> Result<()>) -> Result<u64> {
    let file = File::open(input).with_context(|| format!("open {}", input.display()))?;
    let mut reader = ogg::reading::PacketReader::new(BufReader::new(file));
    let mut decoder = Decoder::new(SampleRate::Hz16000, Channels::Mono)
        .map_err(|e| anyhow!("opus decoder init: {e}"))?;
    let mut total: u64 = 0;
    // 120 ms is the largest Opus packet duration; 16 kHz mono → 1920 samples (+ margin).
    let mut frame = vec![0i16; 2880];
    while let Some(packet) = reader.read_packet().context("read ogg packet")? {
        let data = &packet.data;
        if data.is_empty() || data.starts_with(b"OpusHead") || data.starts_with(b"OpusTags") {
            continue;
        }
        let Ok(n) = decoder.decode(Some(&data[..]), &mut frame[..], false) else {
            continue;
        };
        if n > 0 {
            sink(&frame[..n])?;
            total += n as u64;
        }
    }
    if total == 0 {
        return Err(anyhow!("decoded Opus audio was empty"));
    }
    Ok(total)
}

/// A symphonia format reader, a decoder for its first decodable track, and
/// that track's id.
type OpenedTrack = (
    Box<dyn symphonia::core::formats::FormatReader>,
    Box<dyn symphonia::core::codecs::Decoder>,
    u32,
);

/// Open `input` with symphonia (see [`OpenedTrack`]).
fn open_symphonia(input: &Path) -> Result<OpenedTrack> {
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
    let format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no decodable audio track"))?;
    let track_id = track.id;

    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("no decoder for this codec")?;
    Ok((format, decoder, track_id))
}

/// The symphonia arm of [`stream_16k_mono_i16`]: decode the default audio
/// track packet by packet, downmix each buffer to mono `f32`, resample it to
/// 16 kHz `i16` and hand that to `sink`. Holds one packet's audio at a time.
fn stream_symphonia(input: &Path, sink: &mut dyn FnMut(&[i16]) -> Result<()>) -> Result<u64> {
    let (mut format, mut decoder, track_id) = open_symphonia(input)?;
    let mut resampler: Option<LinearResampler> = None;
    let mut mono: Vec<f32> = Vec::new();
    let mut pcm: Vec<i16> = Vec::new();
    let mut decoded_any = false;
    let mut total: u64 = 0;

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
                // The source rate is the first decoded buffer's.
                let rate = buf.spec().rate;
                let resampler =
                    resampler.get_or_insert_with(|| LinearResampler::new(rate, TARGET_RATE));
                mono.clear();
                downmix_into(&buf, &mut mono);
                decoded_any |= !mono.is_empty();
                pcm.clear();
                resampler.process(&mono, &mut pcm);
                if !pcm.is_empty() {
                    sink(&pcm)?;
                    total += pcm.len() as u64;
                }
            }
            // Recoverable decode hiccups: skip the packet, keep going.
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(symphonia::core::errors::Error::IoError(_)) => break,
            Err(e) => return Err(anyhow!("decode error: {e}")),
        }
    }

    if resampler.is_none() {
        return Err(anyhow!("could not determine source sample rate"));
    }
    if !decoded_any {
        return Err(anyhow!("decoded audio was empty"));
    }
    if total == 0 {
        return Err(anyhow!("resampled audio was empty"));
    }
    Ok(total)
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
    encode_opus_ogg_at(pcm16, out_path, OPUS_BITRATE)
}

/// [`encode_opus_ogg`] at an explicit bitrate (tests use it to fabricate the
/// high-bitrate Ogg/Opus files other recorders produce).
fn encode_opus_ogg_at(pcm16: &[i16], out_path: &Path, bitrate: i32) -> Result<()> {
    let mut writer = OpusOggWriter::create_at(out_path, bitrate)?;
    writer.write(pcm16)?;
    writer.finish()?;
    Ok(())
}

/// An Opus-in-Ogg file written incrementally: 16 kHz mono PCM goes in through
/// [`write`](Self::write) in any chunk sizes, is cut into fixed 20 ms frames and
/// encoded, and Ogg pages go to disk as they fill. [`finish`](Self::finish)
/// zero-pads the last partial frame and ends the stream. The bytes match what
/// encoding the whole buffer at once produced: one packet per 20 ms frame,
/// granule counted at 48 kHz, the final packet marked end-of-stream (which is
/// why one encoded packet is always held back until the next arrives).
pub(crate) struct OpusOggWriter {
    encoder: Encoder,
    writer: ogg::PacketWriter<'static, BufWriter<File>>,
    serial: u32,
    granule: u64,
    /// Samples short of a whole frame, waiting for the next write.
    pending: Vec<i16>,
    /// The last encoded packet and its granule, not yet written.
    held: Option<(Vec<u8>, u64)>,
    encode_buf: Vec<u8>,
    samples: u64,
}

impl OpusOggWriter {
    /// Start a file at the upload bitrate.
    pub(crate) fn create(out_path: &Path) -> Result<Self> {
        Self::create_at(out_path, OPUS_BITRATE)
    }

    fn create_at(out_path: &Path, bitrate: i32) -> Result<Self> {
        let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
            .map_err(|e| anyhow!("opus encoder init: {e}"))?;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(bitrate))
            .map_err(|e| anyhow!("opus set_bitrate: {e}"))?;

        let out_file = File::create(out_path)
            .with_context(|| format!("create temp output {}", out_path.display()))?;
        let mut writer = ogg::PacketWriter::new(BufWriter::new(out_file));

        // A single logical Ogg stream; the serial just needs to be unique per file.
        let serial: u32 = rand_serial();

        // Page 1: the OpusHead identification header (must be its own page).
        writer
            .write_packet(build_opus_head(), serial, PacketWriteEndInfo::EndPage, 0)
            .context("write OpusHead")?;
        // Page 2: the OpusTags comment header (its own page, granule 0).
        writer
            .write_packet(build_opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)
            .context("write OpusTags")?;

        Ok(Self {
            encoder,
            writer,
            serial,
            granule: 0,
            pending: Vec::with_capacity(FRAME_SAMPLES),
            held: None,
            encode_buf: vec![0u8; 4000], // max Opus packet for a 20ms frame
            samples: 0,
        })
    }

    /// Append 16 kHz mono PCM.
    pub(crate) fn write(&mut self, mut pcm: &[i16]) -> Result<()> {
        self.samples += pcm.len() as u64;
        if !self.pending.is_empty() {
            let take = (FRAME_SAMPLES - self.pending.len()).min(pcm.len());
            self.pending.extend_from_slice(&pcm[..take]);
            pcm = &pcm[take..];
            if self.pending.len() < FRAME_SAMPLES {
                return Ok(());
            }
            let mut frame = [0i16; FRAME_SAMPLES];
            frame.copy_from_slice(&self.pending);
            self.pending.clear();
            self.encode_frame(&frame)?;
        }
        let (frames, rest) = pcm.as_chunks::<FRAME_SAMPLES>();
        for frame in frames {
            self.encode_frame(frame)?;
        }
        self.pending.extend_from_slice(rest);
        Ok(())
    }

    /// Encode one whole frame, writing the previously held packet.
    fn encode_frame(&mut self, frame: &[i16]) -> Result<()> {
        let n = self
            .encoder
            .encode(frame, &mut self.encode_buf)
            .map_err(|e| anyhow!("opus encode: {e}"))?;
        self.granule += GRANULE_PER_FRAME;
        let packet = (self.encode_buf[..n].to_vec(), self.granule);
        if let Some((data, granule)) = self.held.replace(packet) {
            self.writer
                .write_packet(data, self.serial, PacketWriteEndInfo::NormalPacket, granule)
                .context("write Opus audio packet")?;
        }
        Ok(())
    }

    /// Encode what's left (zero-padded to a frame), end the stream and flush.
    /// Returns the samples written.
    pub(crate) fn finish(mut self) -> Result<u64> {
        if !self.pending.is_empty() {
            // Opus requires a full frame; zero-pad the final partial frame.
            let mut frame = [0i16; FRAME_SAMPLES];
            frame[..self.pending.len()].copy_from_slice(&self.pending);
            self.pending.clear();
            self.encode_frame(&frame)?;
        }
        if let Some((data, granule)) = self.held.take() {
            self.writer
                .write_packet(data, self.serial, PacketWriteEndInfo::EndStream, granule)
                .context("write Opus audio packet")?;
        }
        self.writer
            .into_inner()
            .flush()
            .context("flush Opus/Ogg output")?;
        Ok(self.samples)
    }
}

/// Build the `OpusHead` identification header packet (19 bytes, mapping family 0).
pub(crate) fn build_opus_head() -> Vec<u8> {
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
pub(crate) fn build_opus_tags() -> Vec<u8> {
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

/// The file-name prefix of a split part ([`compress_for_upload_split`]).
const PART_PREFIX: &str = "parley-part-";

/// A unique temp path for one split part.
fn unique_part_path() -> PathBuf {
    std::env::temp_dir().join(format!("{PART_PREFIX}{}.ogg", uuid::Uuid::new_v4()))
}

/// Delete a split part. Refuses anything that isn't one of ours (a part name in
/// the temp dir), so a path from the webview can never delete a user's file.
pub fn discard_part(path: &Path) -> bool {
    let ours = path.parent() == Some(std::env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(PART_PREFIX) && n.ends_with(".ogg"));
    ours && std::fs::remove_file(path).is_ok()
}

/// One upload's compressed file, kept after transcription so saving the
/// recording to history can move it into place instead of encoding the same
/// source a second time. Remembered with the source's size and mtime so a
/// source that changed in between is encoded afresh.
struct Compressed {
    source: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    temp: PathBuf,
}

/// The remembered compressed uploads, newest last. Bounded: an upload that
/// never gets saved (re-transcribing an old entry, a closed app) costs one temp
/// file until it is evicted, never an unbounded pile.
static COMPRESSED: std::sync::Mutex<Vec<Compressed>> = std::sync::Mutex::new(Vec::new());
const COMPRESSED_KEEP: usize = 4;

fn source_key(source: &Path) -> Option<(PathBuf, u64, Option<std::time::SystemTime>)> {
    let meta = std::fs::metadata(source).ok()?;
    let path = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    Some((path, meta.len(), meta.modified().ok()))
}

/// Remember `temp` as `source` compressed (see [`Compressed`]). Replaces (and
/// deletes) an older one for the same source; evicts the oldest past the bound.
pub fn remember_compressed(source: &Path, temp: PathBuf) {
    let Some((source, len, modified)) = source_key(source) else {
        let _ = std::fs::remove_file(&temp);
        return;
    };
    let mut kept = COMPRESSED.lock().unwrap_or_else(|e| e.into_inner());
    kept.retain(|c| {
        let same = c.source == source;
        if same && c.temp != temp {
            let _ = std::fs::remove_file(&c.temp);
        }
        !same
    });
    kept.push(Compressed {
        source,
        len,
        modified,
        temp,
    });
    while kept.len() > COMPRESSED_KEEP {
        let old = kept.remove(0);
        let _ = std::fs::remove_file(&old.temp);
    }
}

/// Hand over the remembered compressed file for `source`, if there is one and
/// the source is unchanged since. The caller then owns the file.
pub fn take_compressed(source: &Path) -> Option<PathBuf> {
    let (source, len, modified) = source_key(source)?;
    let mut kept = COMPRESSED.lock().unwrap_or_else(|e| e.into_inner());
    let at = kept.iter().position(|c| c.source == source)?;
    let c = kept.remove(at);
    if c.len == len && c.modified == modified && c.temp.is_file() {
        Some(c.temp)
    } else {
        let _ = std::fs::remove_file(&c.temp);
        None
    }
}

/// A unique temp path for a freshly encoded live recording. The caller (stop
/// meeting) hands this path to `save_history_entry`, which moves it into the
/// entry folder, so it only ever lives in the temp dir briefly.
pub(crate) fn unique_recording_path() -> PathBuf {
    std::env::temp_dir().join(format!("parley-recording-{}.ogg", uuid::Uuid::new_v4()))
}

/// A pseudo-unique Ogg stream serial derived from a fresh UUID.
pub(crate) fn rand_serial() -> u32 {
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

    /// One second of a 440 Hz tone at 16 kHz, as i16 PCM.
    fn sine_16k(secs: usize) -> Vec<i16> {
        (0..TARGET_RATE as usize * secs)
            .map(|i| {
                let t = i as f32 / TARGET_RATE as f32;
                ((t * 440.0 * std::f32::consts::TAU).sin() * 12_000.0) as i16
            })
            .collect()
    }

    /// Assert `bytes` is a canonical 16 kHz mono 16-bit PCM WAV and return its
    /// sample count.
    fn assert_wav_16k_mono(bytes: &[u8]) -> usize {
        let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        let u32_at =
            |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32_at(4) as usize, bytes.len() - 8, "RIFF size");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u32_at(16), 16, "fmt chunk size");
        assert_eq!(u16_at(20), 1, "PCM");
        assert_eq!(u16_at(22), 1, "mono");
        assert_eq!(u32_at(24), 16_000, "sample rate");
        assert_eq!(u32_at(28), 32_000, "byte rate");
        assert_eq!(u16_at(32), 2, "block align");
        assert_eq!(u16_at(34), 16, "bits per sample");
        assert_eq!(&bytes[36..40], b"data");
        let data_len = u32_at(40) as usize;
        assert_eq!(data_len, bytes.len() - 44, "data size");
        data_len / 2
    }

    /// The playback fallback's round trip: the app's own Ogg/Opus (as a live
    /// meeting writes it) decodes to a valid WAV of the same length.
    #[test]
    fn ogg_opus_transcodes_to_a_valid_16k_mono_wav() {
        let dir = std::env::temp_dir();
        let ogg = dir.join(format!("parley-test-{}.ogg", uuid::Uuid::new_v4()));
        let wav = dir.join(format!("parley-test-{}.wav", uuid::Uuid::new_v4()));
        encode_opus_ogg(&sine_16k(2), &ogg).expect("encode");

        transcode_to_wav_16k_mono(&ogg, &wav).expect("transcode");
        let bytes = std::fs::read(&wav).unwrap();
        let samples = assert_wav_16k_mono(&bytes);
        // Two seconds, give or take the codec's pre-skip and final-frame padding.
        assert!(
            (31_000..=33_000).contains(&samples),
            "got {samples} samples"
        );
        // Not silence: the tone survived the round trip.
        let peak = (44..bytes.len() - 1)
            .step_by(2)
            .map(|i| i16::from_le_bytes([bytes[i], bytes[i + 1]]).unsigned_abs())
            .max()
            .unwrap();
        assert!(peak > 4_000, "peak {peak}");
        let wav_name = wav.file_name().unwrap().to_string_lossy().into_owned();
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with(&wav_name) && name.ends_with(".part")
            })
            .count();
        assert_eq!(leftovers, 0, "no leftover part file");

        let _ = std::fs::remove_file(&ogg);
        let _ = std::fs::remove_file(&wav);
    }

    /// Anything symphonia reads takes the other decode path — a WAV in, here.
    #[test]
    fn symphonia_input_transcodes_to_wav_too() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("parley-test-src-{}.wav", uuid::Uuid::new_v4()));
        let out = dir.join(format!("parley-test-out-{}.wav", uuid::Uuid::new_v4()));
        let pcm: Vec<f32> = sine_16k(1)
            .iter()
            .map(|&s| f32::from(s) / 32768.0)
            .collect();
        write_wav_16k_mono(&pcm, &src).expect("write source wav");
        assert_eq!(assert_wav_16k_mono(&std::fs::read(&src).unwrap()), 16_000);

        transcode_to_wav_16k_mono(&src, &out).expect("transcode");
        let samples = assert_wav_16k_mono(&std::fs::read(&out).unwrap());
        assert!(
            (15_900..=16_100).contains(&samples),
            "got {samples} samples"
        );

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn every_write_gets_its_own_part_file() {
        let out = std::env::temp_dir().join("parley-test-out.wav");
        let (a, b) = (part_path(&out), part_path(&out));
        assert_ne!(a, b, "two decodes into one output never share a .part");
        for part in [a, b] {
            assert_eq!(part.parent(), out.parent());
            let name = part.file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.starts_with("parley-test-out.wav."), "{name}");
            assert_eq!(part.extension().and_then(|e| e.to_str()), Some("part"));
        }
    }

    #[test]
    fn transcode_rejects_a_file_that_is_not_audio() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("parley-test-{}.ogg", uuid::Uuid::new_v4()));
        let out = dir.join(format!("parley-test-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&src, b"<html>Not Found</html>").unwrap();
        assert!(transcode_to_wav_16k_mono(&src, &out).is_err());
        assert!(!out.exists());
        let _ = std::fs::remove_file(&src);
    }

    /// An Ogg/Opus file from another recorder (here 96 kbps of noisy speech-band
    /// audio) used to fail compression — symphonia has no Opus decoder — and go
    /// up raw. It must now re-encode to a smaller 24 kbps file that decodes.
    #[test]
    fn compress_reencodes_high_bitrate_ogg_opus() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("parley-test-hi-{}.ogg", uuid::Uuid::new_v4()));
        // 10 s of tone + pseudo-random noise so the encoder actually spends
        // the bitrate it's given (a pure tone would compress to nearly nothing).
        let mut seed: u32 = 0x1234_5678;
        let pcm: Vec<i16> = sine_16k(10)
            .into_iter()
            .map(|s| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = ((seed >> 16) as i16) / 4;
                s.saturating_add(noise)
            })
            .collect();
        encode_opus_ogg_at(&pcm, &src, 96_000).expect("encode 96 kbps source");
        assert!(is_ogg_opus(&src).unwrap());

        let out = compress_for_upload(&src).expect("Ogg/Opus input should compress");
        let (src_size, out_size) = (
            std::fs::metadata(&src).unwrap().len(),
            std::fs::metadata(&out).unwrap().len(),
        );
        eprintln!("src={src_size} bytes, out={out_size} bytes");
        assert!(
            out_size * 2 < src_size,
            "96 → 24 kbps should at least halve it"
        );

        // The output is our own 16 kHz mono Ogg/Opus and decodes to ~10 s.
        assert!(is_ogg_opus(&out).unwrap());
        let samples = decode_to_16k_mono(&out).expect("output decodes");
        assert!(
            (159_000..=161_000).contains(&samples.len()),
            "got {} samples",
            samples.len()
        );

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    /// A 16-bit PCM WAV at any rate/channel count (the test inputs symphonia reads).
    fn write_wav(path: &Path, rate: u32, channels: u16, interleaved: &[i16]) {
        let data_len = (interleaved.len() * 2) as u32;
        let mut bytes = wav_header(rate, channels, data_len).to_vec();
        for s in interleaved {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    /// `secs` of stereo 44.1 kHz tone + noise, interleaved.
    fn stereo_44k(secs: f32) -> Vec<i16> {
        let frames = (44_100.0 * secs) as usize;
        let mut seed: u32 = 0x9e37_79b9;
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let t = i as f32 / 44_100.0;
            let tone = (t * 330.0 * std::f32::consts::TAU).sin() * 9_000.0;
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = f32::from((seed >> 16) as i16) / 8.0;
            out.push((tone + noise) as i16);
            out.push((tone * 0.5 - noise) as i16);
        }
        out
    }

    fn temp(name: &str, ext: &str) -> PathBuf {
        std::env::temp_dir().join(format!("parley-test-{name}-{}.{ext}", uuid::Uuid::new_v4()))
    }

    fn collect_16k(input: &Path) -> Vec<i16> {
        let mut out = Vec::new();
        stream_16k_mono_i16(input, &mut |pcm| {
            out.extend_from_slice(pcm);
            Ok(())
        })
        .unwrap();
        out
    }

    /// The streaming pipeline feeds the encoder exactly the PCM the old
    /// whole-buffer one did (decode all → downmix → one resampler call), so the
    /// upload decodes to the same length as before.
    #[test]
    fn streaming_compress_matches_the_whole_buffer_pipeline() {
        let wav = temp("stereo", "wav");
        let interleaved = stereo_44k(7.3);
        write_wav(&wav, 44_100, 2, &interleaved);

        // The old pipeline, in one go.
        let mono: Vec<f32> = interleaved
            .as_chunks::<2>()
            .0
            .iter()
            .map(|f| (f32::from(f[0]) / 32768.0 + f32::from(f[1]) / 32768.0) / 2.0)
            .collect();
        let mut expected: Vec<i16> = Vec::new();
        LinearResampler::new(44_100, TARGET_RATE).process(&mono, &mut expected);

        assert_eq!(
            collect_16k(&wav),
            expected,
            "streamed PCM is the whole-buffer PCM"
        );

        let reference = temp("ref", "ogg");
        encode_opus_ogg(&expected, &reference).unwrap();
        let out = compress_for_upload(&wav).unwrap();
        let (got, want) = (
            decode_to_16k_mono(&out).unwrap().len(),
            decode_to_16k_mono(&reference).unwrap().len(),
        );
        assert!(
            got.abs_diff(want) <= FRAME_SAMPLES,
            "got {got}, before {want}"
        );
        assert_eq!(
            std::fs::metadata(&out).unwrap().len(),
            std::fs::metadata(&reference).unwrap().len(),
            "same packets, same pages"
        );
        for f in [&wav, &reference, &out] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// Feeding the writer in odd chunk sizes encodes the same frames as one call.
    #[test]
    fn opus_writer_is_chunking_invariant() {
        let pcm = sine_16k(3);
        let (whole, chunked) = (temp("whole", "ogg"), temp("chunked", "ogg"));
        encode_opus_ogg(&pcm, &whole).unwrap();
        let mut w = OpusOggWriter::create(&chunked).unwrap();
        let mut rest = &pcm[..];
        for size in [1usize, 319, 321, 7, 4000, 640].iter().cycle() {
            if rest.is_empty() {
                break;
            }
            let take = (*size).min(rest.len());
            w.write(&rest[..take]).unwrap();
            rest = &rest[take..];
        }
        assert_eq!(w.finish().unwrap(), pcm.len() as u64);
        assert_eq!(collect_16k(&whole), collect_16k(&chunked));
        for f in [&whole, &chunked] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// Splitting writes `n` upload-ready files whose lengths add up to the
    /// source; all but the last hold exactly `part_len` samples.
    #[test]
    fn split_writes_equal_parts_that_sum_to_the_source() {
        let wav = temp("split-src", "wav");
        let interleaved = stereo_44k(9.5);
        write_wav(&wav, 44_100, 2, &interleaved);
        let total = collect_16k(&wav).len() as u64;

        let part_len = total.div_ceil(3);
        let parts = write_parts(&wav, Some(part_len), 3, unique_part_path).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.iter().map(|p| p.1).sum::<u64>(), total);
        assert!(parts[..2].iter().all(|p| p.1 == part_len));
        let mut decoded_total = 0usize;
        for (path, samples) in &parts {
            assert!(is_upload_ready(path), "a part uploads as is");
            let got = decode_to_16k_mono(path).unwrap().len();
            // Each part pads its last frame (and drops the encoder look-ahead).
            assert!(
                got.abs_diff(*samples as usize) <= FRAME_SAMPLES,
                "{got} vs {samples}"
            );
            decoded_total += got;
        }
        assert!(decoded_total.abs_diff(total as usize) <= 3 * FRAME_SAMPLES);
        for (path, _) in &parts {
            assert!(discard_part(path));
            assert!(!path.exists());
        }

        // The public entry point cuts from the declared duration.
        let parts = compress_for_upload_split(&wav, 2).unwrap();
        assert_eq!(parts.len(), 2);
        let lens: Vec<usize> = parts
            .iter()
            .map(|p| decode_to_16k_mono(p).unwrap().len())
            .collect();
        assert!(lens[0].abs_diff(lens[1]) <= 2 * FRAME_SAMPLES, "{lens:?}");
        assert!((lens[0] + lens[1]).abs_diff(total as usize) <= 2 * FRAME_SAMPLES);
        for p in &parts {
            assert!(discard_part(p));
        }
        let _ = std::fs::remove_file(&wav);
    }

    #[test]
    fn split_parts_are_equal_for_the_declared_duration() {
        assert_eq!(equal_part_samples(21_000_000, 2), 168_000_000);
        assert_eq!(equal_part_samples(1_000, 3), 5_334);
        assert_eq!(equal_part_samples(0, 3), FRAME_SAMPLES as u64);
    }

    #[test]
    fn discard_part_refuses_files_that_are_not_parts() {
        let other = temp("not-a-part", "ogg");
        std::fs::write(&other, b"x").unwrap();
        assert!(!discard_part(&other));
        assert!(other.exists());
        let _ = std::fs::remove_file(&other);
        assert!(!discard_part(Path::new("/Users/someone/parley-part-x.ogg")));
    }

    #[test]
    fn probe_reads_duration_without_decoding() {
        let wav = temp("probe", "wav");
        write_wav(&wav, 44_100, 2, &stereo_44k(4.0));
        let p = probe_audio(&wav).unwrap();
        assert_eq!(p.duration_ms, Some(4_000));
        assert!(p.compressible);
        assert_eq!(p.bytes, std::fs::metadata(&wav).unwrap().len());

        let ogg = compress_for_upload(&wav).unwrap();
        let p = probe_audio(&ogg).unwrap();
        // Granule of the last page, less pre-skip; the last frame is padded.
        let ms = p.duration_ms.unwrap();
        assert!((3_990..=4_030).contains(&ms), "{ms}");
        assert!(p.compressible);
        assert!(is_upload_ready(&ogg));
        assert!(!is_upload_ready(&wav));

        let junk = temp("junk", "webm");
        std::fs::write(&junk, b"\x1aE\xdf\xa3 not really a webm").unwrap();
        let p = probe_audio(&junk).unwrap();
        assert_eq!(p.duration_ms, None);
        assert!(!p.compressible);
        for f in [&wav, &ogg, &junk] {
            let _ = std::fs::remove_file(f);
        }
    }

    #[test]
    fn last_granule_skips_truncated_and_unset_pages() {
        let page = |granule: u64, body: &[u8]| {
            let mut p = b"OggS\0\0".to_vec();
            p.extend_from_slice(&granule.to_le_bytes());
            p.extend_from_slice(&[0u8; 12]); // serial, sequence, crc
            p.push(1);
            p.push(body.len() as u8);
            p.extend_from_slice(body);
            p
        };
        let mut bytes = b"junk".to_vec();
        bytes.extend(page(960, b"abc"));
        bytes.extend(page(1920, b"de"));
        bytes.extend(page(u64::MAX, b"f"));
        assert_eq!(last_granule_in(&bytes), Some(1920));
        let mut cut = bytes.clone();
        cut.extend(&page(9_999, b"truncated")[..30]);
        assert_eq!(last_granule_in(&cut), Some(1920));
        assert_eq!(last_granule_in(b"nothing here"), None);
    }

    /// A high-bitrate Ogg/Opus from another recorder still gets compressed.
    #[test]
    fn high_bitrate_opus_is_not_upload_ready() {
        let src = temp("hi", "ogg");
        let mut seed: u32 = 7;
        let pcm: Vec<i16> = sine_16k(4)
            .into_iter()
            .map(|s| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                s.saturating_add(((seed >> 16) as i16) / 4)
            })
            .collect();
        encode_opus_ogg_at(&pcm, &src, 96_000).unwrap();
        assert!(!is_upload_ready(&src));
        let _ = std::fs::remove_file(&src);
    }

    /// The upload's compressed file is handed to the history save once, and only
    /// while the source is unchanged.
    #[test]
    fn a_remembered_compression_is_taken_once_and_only_for_an_unchanged_source() {
        let src = temp("remember-src", "wav");
        write_wav(&src, 16_000, 1, &sine_16k(1));
        let tmp = compress_for_upload(&src).unwrap();
        remember_compressed(&src, tmp.clone());
        assert_eq!(take_compressed(&src), Some(tmp.clone()));
        assert_eq!(take_compressed(&src), None, "handed over once");

        let tmp2 = compress_for_upload(&src).unwrap();
        remember_compressed(&src, tmp2.clone());
        write_wav(&src, 16_000, 1, &sine_16k(2)); // the source changed
        assert_eq!(take_compressed(&src), None);
        assert!(!tmp2.exists(), "a stale compression is deleted");
        for f in [&src, &tmp] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// Peak memory of compressing a long file stays flat (it used to grow by
    /// ~0.8 GB per hour of 48 kHz stereo). Needs ffmpeg to make the input and
    /// takes a while, so it is ignored by default:
    /// `cargo test --release --lib peak_memory -- --ignored --nocapture`.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn compress_peak_memory_stays_flat_for_an_hour_of_audio() {
        let mp3 = temp("hour", "mp3");
        let made = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anoisesrc=r=48000:a=0.1",
            ])
            .args([
                "-ac",
                "2",
                "-t",
                "3600",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
            ])
            .arg(&mp3)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !made {
            eprintln!("ffmpeg not available; skipping");
            return;
        }
        let peak = || {
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
            // Bytes on macOS, KiB on Linux.
            let raw = usage.ru_maxrss as u64;
            if cfg!(target_os = "macos") {
                raw
            } else {
                raw * 1024
            }
        };
        let before = peak();
        let out = compress_for_upload(&mp3).unwrap();
        let after = peak();
        eprintln!(
            "peak RSS before={before} after={after} (+{} MB)",
            (after - before) >> 20
        );
        assert!(
            after - before < 100 << 20,
            "compression grew the peak by {} MB",
            (after - before) >> 20
        );
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&mp3);
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
