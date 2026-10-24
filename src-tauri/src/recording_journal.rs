//! A crash-safe copy of the live meeting's recording, written to disk as it
//! is captured.
//!
//! The recording itself lives in RAM until the meeting stops (see
//! `capture::Recording`), and is encoded in one go at stop. A crash, a quit
//! or a force-quit before that lost the whole meeting. So alongside the RAM
//! buffer, every recorded chunk is also streamed here: Opus-encoded into an
//! Ogg file under `<app_data_dir>/recordings-in-progress/<meeting id>.ogg`,
//! closing a page every [`PAGE_FRAMES`] frames and fsyncing every
//! [`SYNC_EVERY`], so at most a few seconds are lost however the process dies.
//!
//! A normal stop still saves the RAM encode (byte-for-byte the recording it
//! always saved); the journal is only deleted once the frontend has written
//! the history entry (`finish_meeting_journal`). A journal still on disk at
//! the next launch is a meeting that never made it into history — it is
//! repaired into a clean Ogg file and handed to the frontend to save as a
//! recording (`recover_meeting_journals`), the way iOS recovers an orphaned
//! Ogg file after a crash.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};

use crate::replay_audio::{
    build_opus_head, build_opus_tags, rand_serial, FRAME_SAMPLES, GRANULE_PER_FRAME, OPUS_BITRATE,
};

/// Close an Ogg page every this many 20 ms frames (1 s): a page is the unit a
/// reader can recover, so this bounds what a crash loses to the open page.
const PAGE_FRAMES: u32 = 50;
/// fsync the journal this often. Between syncs a page sits in the OS cache,
/// which survives the app crashing — only a kernel panic or power loss needs
/// the sync.
const SYNC_EVERY: Duration = Duration::from_secs(10);
/// A recovered journal shorter than this is an accidental Start, not a
/// meeting — the same floor `stop_meeting` applies.
pub const MIN_RECOVER_MS: u64 = 2_000;
/// The journal directory's name under the app data dir.
const DIR_NAME: &str = "recordings-in-progress";

/// Where in-progress meeting journals live.
pub fn journal_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DIR_NAME)
}

/// A meeting id is used as a file name: accept only what a UUID can contain,
/// so a frontend value can never name a path outside the journal directory.
pub fn valid_meeting_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The journal file of meeting `id`.
pub fn audio_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.ogg"))
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Streaming Opus-in-Ogg encoder for 16 kHz mono PCM. Same stream layout as
/// `replay_audio::encode_opus_ogg` (OpusHead page, OpusTags page, one packet
/// per 20 ms frame, granule at 48 kHz), but written as audio arrives.
pub struct OpusOggStream<W: Write> {
    encoder: Encoder,
    writer: PacketWriter<'static, W>,
    serial: u32,
    /// Samples waiting for a full 20 ms frame.
    pending: Vec<i16>,
    granule: u64,
    frames_in_page: u32,
    packet: Vec<u8>,
}

impl<W: Write> OpusOggStream<W> {
    pub fn new(out: W) -> Result<Self> {
        let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
            .map_err(|e| anyhow!("opus encoder init: {e}"))?;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(OPUS_BITRATE))
            .map_err(|e| anyhow!("opus set_bitrate: {e}"))?;
        let mut writer = PacketWriter::new(out);
        let serial = rand_serial();
        writer
            .write_packet(build_opus_head(), serial, PacketWriteEndInfo::EndPage, 0)
            .context("write OpusHead")?;
        writer
            .write_packet(build_opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)
            .context("write OpusTags")?;
        Ok(Self {
            encoder,
            writer,
            serial,
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
            granule: 0,
            frames_in_page: 0,
            packet: vec![0u8; 4000],
        })
    }

    /// Encode whatever full frames `pcm` completes. Returns whether a page was
    /// closed (i.e. bytes reached the writer).
    pub fn push(&mut self, pcm: &[i16]) -> Result<bool> {
        self.pending.extend_from_slice(pcm);
        let mut closed = false;
        let mut at = 0;
        while self.pending.len() - at >= FRAME_SAMPLES {
            let frame: [i16; FRAME_SAMPLES] =
                self.pending[at..at + FRAME_SAMPLES].try_into().unwrap();
            at += FRAME_SAMPLES;
            self.frames_in_page += 1;
            let end = if self.frames_in_page >= PAGE_FRAMES {
                self.frames_in_page = 0;
                closed = true;
                PacketWriteEndInfo::EndPage
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            self.encode_frame(&frame, end)?;
        }
        self.pending.drain(..at);
        Ok(closed)
    }

    fn encode_frame(
        &mut self,
        frame: &[i16; FRAME_SAMPLES],
        end: PacketWriteEndInfo,
    ) -> Result<()> {
        let n = self
            .encoder
            .encode(frame, &mut self.packet)
            .map_err(|e| anyhow!("opus encode: {e}"))?;
        self.granule += GRANULE_PER_FRAME;
        self.writer
            .write_packet(self.packet[..n].to_vec(), self.serial, end, self.granule)
            .context("write Opus audio packet")
    }

    /// The writer underneath (to flush / fsync it).
    pub fn inner_mut(&mut self) -> &mut W {
        self.writer.inner_mut()
    }

    /// End the stream: the partial last frame zero-padded, flagged
    /// end-of-stream. A stream that never got a sample ends with one silent
    /// frame, so the file is still a complete Ogg stream.
    pub fn finish(mut self) -> Result<W> {
        let mut frame = [0i16; FRAME_SAMPLES];
        frame[..self.pending.len()].copy_from_slice(&self.pending);
        self.pending.clear();
        self.encode_frame(&frame, PacketWriteEndInfo::EndStream)?;
        let mut out = self.writer.into_inner();
        out.flush().context("flush Ogg stream")?;
        Ok(out)
    }
}

/// The journal's sidecar: what the recovery needs that the audio cannot say.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMeta {
    pub meeting_id: String,
    /// When the meeting started (epoch ms) — the recovered entry's date.
    pub started_at_ms: u64,
}

/// One live meeting's journal: the file plus the writer thread that encodes
/// into it. Chunks are handed over a channel so the capture path never waits
/// on the encoder or the disk.
pub struct RecordingJournal {
    tx: Option<Sender<Vec<i16>>>,
    thread: Option<JoinHandle<()>>,
    id: String,
}

impl RecordingJournal {
    /// Create `<dir>/<id>.ogg` (+ its sidecar) and start the writer thread.
    pub fn start(dir: &Path, meta: &JournalMeta) -> Result<Self> {
        if !valid_meeting_id(&meta.meeting_id) {
            return Err(anyhow!("invalid meeting id"));
        }
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        std::fs::write(meta_path(dir, &meta.meeting_id), serde_json::to_vec(meta)?)
            .context("write journal sidecar")?;
        let path = audio_path(dir, &meta.meeting_id);
        let file = File::create(&path).with_context(|| format!("create {}", path.display()))?;
        let mut stream = OpusOggStream::new(BufWriter::new(file))?;
        // The headers are on disk before the first chunk: a journal that
        // exists always parses as an Opus stream.
        sync(stream.inner_mut());
        let (tx, rx) = channel::<Vec<i16>>();
        let id = meta.meeting_id.clone();
        let thread = std::thread::Builder::new()
            .name("recording-journal".into())
            .spawn(move || write_journal(stream, rx))
            .context("spawn journal thread")?;
        log::info!("recording journal: started {}", path.display());
        Ok(Self {
            tx: Some(tx),
            thread: Some(thread),
            id,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Queue one recorded chunk.
    pub fn push(&self, chunk: &[i16]) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(chunk.to_vec());
        }
    }

    /// Stop accepting audio and wait for everything queued to be written and
    /// synced. The file stays: it is deleted once the entry is saved.
    pub fn close(mut self) {
        self.tx.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for RecordingJournal {
    fn drop(&mut self) {
        // Closing the channel lets the thread finish on its own.
        self.tx.take();
    }
}

/// The writer thread: encode every queued chunk, hand each closed page to the
/// OS, fsync now and then, and end the stream once the channel closes.
fn write_journal(
    mut stream: OpusOggStream<BufWriter<File>>,
    rx: std::sync::mpsc::Receiver<Vec<i16>>,
) {
    let mut last_sync = Instant::now();
    while let Ok(chunk) = rx.recv() {
        match stream.push(&chunk) {
            Ok(closed) => {
                if closed {
                    // A page is complete: a crash now loses at most the next one.
                    let _ = stream.inner_mut().flush();
                }
                if closed && last_sync.elapsed() >= SYNC_EVERY {
                    sync(stream.inner_mut());
                    last_sync = Instant::now();
                }
            }
            Err(e) => {
                log::error!("recording journal: write failed, journal stops here: {e}");
                return;
            }
        }
    }
    match stream.finish() {
        Ok(mut out) => sync(&mut out),
        Err(e) => log::warn!("recording journal: finishing failed: {e}"),
    }
}

fn sync(out: &mut BufWriter<File>) {
    if let Err(e) = out.flush().and_then(|()| out.get_ref().sync_data()) {
        log::warn!("recording journal: sync failed: {e}");
    }
}

/// Delete a meeting's journal and sidecar. Missing files are fine.
pub fn remove(dir: &Path, id: &str) {
    if !valid_meeting_id(id) {
        return;
    }
    for p in [audio_path(dir, id), meta_path(dir, id)] {
        match std::fs::remove_file(&p) {
            Ok(()) => log::info!("recording journal: removed {}", p.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("recording journal: remove {} failed: {e}", p.display()),
        }
    }
}

/// Rewrite a journal — possibly cut off mid-page by a crash — as a clean,
/// complete Ogg Opus file at `out`: every audio packet up to the last intact
/// page, renumbered, the last one flagged end-of-stream. Returns the audio
/// duration in ms (`0` = no audio survived; nothing is written then).
pub fn repair(journal: &Path, out: &Path) -> Result<u64> {
    let file = File::open(journal).with_context(|| format!("open {}", journal.display()))?;
    // The first two packets are OpusHead / OpusTags; they are rewritten fresh.
    let packets: Vec<Vec<u8>> = intact_packets(PacketReader::new(BufReader::new(file)))
        .skip(2)
        .collect();
    if packets.is_empty() {
        return Ok(0);
    }
    let file = File::create(out).with_context(|| format!("create {}", out.display()))?;
    let mut writer = PacketWriter::new(BufWriter::new(file));
    let serial = rand_serial();
    writer.write_packet(build_opus_head(), serial, PacketWriteEndInfo::EndPage, 0)?;
    writer.write_packet(build_opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)?;
    let total = packets.len();
    let mut granule = 0u64;
    for (i, data) in packets.into_iter().enumerate() {
        granule += GRANULE_PER_FRAME;
        let end = if i + 1 == total {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer.write_packet(data, serial, end, granule)?;
    }
    writer.into_inner().flush()?;
    // One packet = one 20 ms frame.
    Ok(total as u64 * 20)
}

/// Every packet up to the first damaged page: a torn final page (the crash)
/// or garbage after it ends the stream, and what came before is kept.
fn intact_packets<R: std::io::Read + std::io::Seek>(
    mut reader: PacketReader<R>,
) -> impl Iterator<Item = Vec<u8>> {
    std::iter::from_fn(move || match reader.read_packet() {
        Ok(p) => p.map(|p| p.data),
        Err(e) => {
            log::info!("recording journal: stopped reading at a damaged page: {e}");
            None
        }
    })
}

/// A journal recovered into a saveable recording.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    pub meeting_id: String,
    /// The repaired recording, a `parley-recording-*.ogg` in the temp dir —
    /// the same kind of file `stop_meeting` hands over, so the frontend saves
    /// (or discards) it the same way.
    pub path: String,
    pub duration_ms: u64,
    pub started_at_ms: u64,
}

/// Recover every journal in `dir` except the ids in `skip` (a meeting still
/// recording, or one whose stop is still being saved). Too-short and empty
/// journals are deleted; the others are repaired to `out_path()` and listed.
/// The journals themselves stay until the frontend confirms the save.
pub fn recover_all(
    dir: &Path,
    skip: &[String],
    mut out_path: impl FnMut() -> PathBuf,
) -> Vec<Recovered> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = read
        .filter_map(|e| journal_id_of(&e.ok()?.file_name()))
        .filter(|id| !skip.contains(id))
        .collect();
    ids.sort();
    ids.into_iter()
        .filter_map(|id| recover_one(dir, id, out_path()))
        .collect()
}

/// The meeting id a journal directory entry belongs to, if it is a journal.
fn journal_id_of(name: &std::ffi::OsStr) -> Option<String> {
    let id = name.to_str()?.strip_suffix(".ogg")?;
    valid_meeting_id(id).then(|| id.to_string())
}

/// When meeting `id` started: its sidecar, else the journal's creation time.
fn started_at_of(dir: &Path, id: &str) -> u64 {
    let from_meta = std::fs::read(meta_path(dir, id))
        .ok()
        .and_then(|b| serde_json::from_slice::<JournalMeta>(&b).ok())
        .map(|m| m.started_at_ms);
    from_meta
        .or_else(|| {
            let created = std::fs::metadata(audio_path(dir, id))
                .ok()?
                .created()
                .ok()?;
            let since = created.duration_since(std::time::UNIX_EPOCH).ok()?;
            Some(since.as_millis() as u64)
        })
        .unwrap_or(0)
}

/// Repair one journal into `target`. Too-short journals are deleted; an
/// unreadable one is left for a later launch / a bug report.
fn recover_one(dir: &Path, id: String, target: PathBuf) -> Option<Recovered> {
    match repair(&audio_path(dir, &id), &target) {
        Ok(ms) if ms >= MIN_RECOVER_MS => {
            log::warn!("recording journal: recovered unfinished meeting {id} ({ms} ms)");
            Some(Recovered {
                started_at_ms: started_at_of(dir, &id),
                meeting_id: id,
                path: target.to_string_lossy().into_owned(),
                duration_ms: ms,
            })
        }
        Ok(ms) => {
            log::info!("recording journal: dropping too-short journal {id} ({ms} ms)");
            let _ = std::fs::remove_file(&target);
            remove(dir, &id);
            None
        }
        Err(e) => {
            log::error!("recording journal: could not recover {id}: {e}");
            let _ = std::fs::remove_file(&target);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("parley-journal-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn tone(samples: usize) -> Vec<i16> {
        (0..samples)
            .map(|i| {
                (((i as f32) / 16_000.0 * 440.0 * std::f32::consts::TAU).sin() * 9_000.0) as i16
            })
            .collect()
    }

    fn meta(id: &str) -> JournalMeta {
        JournalMeta {
            meeting_id: id.into(),
            started_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn meeting_ids_cannot_name_a_path() {
        assert!(valid_meeting_id("3f2b9c1e-0000-4000-8000-000000000000"));
        assert!(!valid_meeting_id(""));
        assert!(!valid_meeting_id("../x"));
        assert!(!valid_meeting_id("a/b"));
        assert!(!valid_meeting_id(&"a".repeat(65)));
    }

    #[test]
    fn a_closed_journal_recovers_every_second_it_was_given() {
        let dir = tmp_dir("closed");
        let j = RecordingJournal::start(&dir, &meta("m1")).unwrap();
        // 5 s in uneven chunks, as capture delivers them.
        let pcm = tone(16_000 * 5);
        for c in pcm.chunks(1_234) {
            j.push(c);
        }
        j.close();
        let out = dir.join("out.ogg");
        let ms = repair(&audio_path(&dir, "m1"), &out).unwrap();
        // 250 full frames + the zero-padded tail frame `finish` writes.
        assert_eq!(ms, 5_000 + 20);
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[..4], b"OggS");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The crash: the process dies with the journal mid-page. Everything up to
    /// the last complete page survives.
    #[test]
    fn a_journal_cut_off_mid_page_keeps_its_complete_pages() {
        let dir = tmp_dir("torn");
        let path = audio_path(&dir, "m2");
        {
            let file = File::create(&path).unwrap();
            let mut s = OpusOggStream::new(BufWriter::new(file)).unwrap();
            s.push(&tone(16_000 * 3)).unwrap(); // 150 frames = 3 closed pages
            s.inner_mut().flush().unwrap();
            // Not finished: no EOS page, as after a crash.
        }
        // Tear the file a few bytes into a page that never completed.
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"OggS\0\0\0garbage");
        std::fs::write(&path, &bytes).unwrap();
        let out = dir.join("out.ogg");
        assert_eq!(repair(&path, &out).unwrap(), 3_000);
        // And the repaired file reads back cleanly to the same length.
        assert_eq!(repair(&out, &dir.join("again.ogg")).unwrap(), 3_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_skips_the_live_meeting_and_drops_accidental_starts() {
        let dir = tmp_dir("recover");
        for (id, secs) in [("live", 4), ("crashed", 4), ("blip", 1)] {
            let j = RecordingJournal::start(&dir, &meta(id)).unwrap();
            j.push(&tone(16_000 * secs));
            j.close();
        }
        let n = std::cell::Cell::new(0);
        let found = recover_all(&dir, &["live".to_string()], || {
            n.set(n.get() + 1);
            dir.join(format!("rec-{}.ogg", n.get()))
        });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].meeting_id, "crashed");
        assert_eq!(found[0].started_at_ms, 1_700_000_000_000);
        assert!(found[0].duration_ms >= 4_000);
        assert!(Path::new(&found[0].path).exists());
        // The crashed journal stays until its entry is saved; the blip is gone.
        assert!(audio_path(&dir, "crashed").exists());
        assert!(!audio_path(&dir, "blip").exists());
        assert!(audio_path(&dir, "live").exists());
        remove(&dir, "crashed");
        assert!(!audio_path(&dir, "crashed").exists());
        assert!(!meta_path(&dir, "crashed").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
