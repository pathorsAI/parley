//! The user's voiceprint: one CAM++ speaker embedding of their own voice, kept
//! on this computer only, so a recording can tell which diarized speaker is the
//! user without asking.
//!
//! It is enrolled from the onboarding mic check (the user reading their
//! self-introduction) and refined every time the user marks a speaker as
//! themselves (這是我). Matching embeds a sample of each speaker's lines in a
//! recording and returns each one's cosine similarity to the voiceprint; the
//! frontend decides whether one of them clearly is the user
//! (`src/lib/speakers/voiceprint.ts`).
//!
//! Same model and embedding path as `diarize.rs`, so a voiceprint is directly
//! comparable to the embeddings that clustering uses.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::diarize::{self, MIN_SLICE_SAMPLES, SAMPLES_PER_MS};
use crate::replay_audio::decode_to_16k_mono;

const FILE: &str = "voiceprint.json";
/// Less speech than this makes an unreliable voiceprint; it is not saved.
const MIN_ENROLL_MS: u64 = 3_000;
/// When refining, the old voiceprint counts as at most this much speech, so a
/// fresh mark (a new mic, a new room) still moves it.
const OLD_WEIGHT_CAP_MS: u64 = 120_000;
/// Per speaker, embed at most this much of their speech (longest lines first):
/// plenty for a stable centroid, and bounded on an hour-long meeting.
const MAX_GROUP_MS: u64 = 90_000;
/// The mic check's audio is cut into frames this long for the speech gate.
const FRAME_MS: usize = 100;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stored {
    embedding: Vec<f32>,
    speech_ms: u64,
    updated_at: u64,
    /// "mic-check" or "marked".
    source: String,
}

/// What the frontend may know about the voiceprint (never the vector itself).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintStatus {
    speech_ms: u64,
    updated_at: u64,
    source: String,
}

impl From<&Stored> for VoiceprintStatus {
    fn from(s: &Stored) -> Self {
        Self {
            speech_ms: s.speech_ms,
            updated_at: s.updated_at,
            source: s.source.clone(),
        }
    }
}

/// A stretch of the audio file, in ms on the file's own clock.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    start_ms: u64,
    end_ms: u64,
}

/// One speaker's lines, to compare against the voiceprint.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSpans {
    key: String,
    spans: Vec<Span>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMatch {
    key: String,
    similarity: f32,
    /// How much of the speaker's audio was embedded.
    speech_ms: u64,
}

fn file_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().context("app data dir")?.join(FILE))
}

fn load(app: &AppHandle) -> Option<Stored> {
    let bytes = std::fs::read(file_path(app).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save(app: &AppHandle, stored: &Stored) -> Result<()> {
    let path = file_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_vec(stored)?)?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Load the runtime and the model; the model downloads once if missing.
async fn session_model(app: &AppHandle) -> Result<PathBuf> {
    diarize::locate_and_set_dylib(app)?;
    diarize::ensure_model(app).await
}

/// The length-weighted mean direction of `spans` of `audio`, longest first up
/// to [`MAX_GROUP_MS`]. None when nothing was long enough to embed.
fn embed_spans(session: &mut ort::session::Session, audio: &[f32], spans: &[Span]) -> Option<(Vec<f32>, u64)> {
    let mut spans = spans.to_vec();
    spans.sort_by_key(|s| std::cmp::Reverse(s.end_ms.saturating_sub(s.start_ms)));
    let mut acc: Vec<f32> = Vec::new();
    let mut used_ms = 0u64;
    for sp in spans {
        if used_ms >= MAX_GROUP_MS {
            break;
        }
        let start = (sp.start_ms as usize * SAMPLES_PER_MS).min(audio.len());
        let end = (sp.end_ms as usize * SAMPLES_PER_MS).min(audio.len());
        if end <= start || end - start < MIN_SLICE_SAMPLES {
            continue;
        }
        match diarize::embed_segment(session, &audio[start..end]) {
            Ok(v) => {
                let ms = ((end - start) / SAMPLES_PER_MS) as u64;
                if acc.is_empty() {
                    acc = vec![0.0; v.len()];
                }
                for (a, x) in acc.iter_mut().zip(&v) {
                    *a += x * ms as f32;
                }
                used_ms += ms;
            }
            Err(e) => log::warn!("voiceprint: embed failed: {e:#}"),
        }
    }
    (used_ms > 0).then(|| (diarize::l2_normalize(&acc), used_ms))
}

/// Fold a new embedding into the stored one (or start over with `replace`).
fn blend(old: Option<Stored>, new: Vec<f32>, new_ms: u64, source: &str, replace: bool) -> Stored {
    let embedding = match old.as_ref().filter(|o| !replace && o.embedding.len() == new.len()) {
        Some(o) => {
            let w_old = o.speech_ms.min(OLD_WEIGHT_CAP_MS) as f32;
            let w_new = new_ms as f32;
            let mixed: Vec<f32> = o.embedding.iter().zip(&new).map(|(a, b)| a * w_old + b * w_new).collect();
            diarize::l2_normalize(&mixed)
        }
        None => new,
    };
    let speech_ms = match old.filter(|_| !replace) {
        Some(o) => o.speech_ms.saturating_add(new_ms),
        None => new_ms,
    };
    Stored {
        embedding,
        speech_ms,
        updated_at: now_ms(),
        source: source.to_string(),
    }
}

/// Keep only the frames that carry speech: a frame counts when its energy is
/// well above the take's quiet floor. The mic check is mostly speech, but its
/// lead-in and tail are silence, which would blur the embedding.
fn speech_only(pcm: &[i16]) -> Vec<f32> {
    let frame = FRAME_MS * SAMPLES_PER_MS;
    let frames: Vec<&[i16]> = pcm.chunks(frame).filter(|f| f.len() == frame).collect();
    if frames.is_empty() {
        return Vec::new();
    }
    let rms: Vec<f32> = frames
        .iter()
        .map(|f| {
            let e: f32 = f.iter().map(|&x| (x as f32 / 32768.0).powi(2)).sum();
            (e / f.len() as f32).sqrt()
        })
        .collect();
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let loud = sorted[sorted.len() * 9 / 10];
    let gate = (floor + (loud - floor) * 0.2).max(0.005);
    let mut out = Vec::new();
    for (f, r) in frames.iter().zip(&rms) {
        if *r >= gate {
            out.extend(f.iter().map(|&x| x as f32 / 32768.0));
        }
    }
    out
}

/// Enroll from the onboarding mic check's audio (16 kHz mono), replacing any
/// voiceprint: it is the user reading on purpose, the cleanest sample there
/// is. Runs in the background; a failure is only logged.
pub(crate) fn enroll_from_mic_check(app: AppHandle, pcm: Vec<i16>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = enroll_pcm(&app, pcm).await {
            log::warn!("voiceprint: mic-check enroll skipped: {e:#}");
        }
    });
}

async fn enroll_pcm(app: &AppHandle, pcm: Vec<i16>) -> Result<()> {
    let speech = speech_only(&pcm);
    let speech_ms = (speech.len() / SAMPLES_PER_MS) as u64;
    if speech_ms < MIN_ENROLL_MS {
        bail!("only {speech_ms} ms of speech");
    }
    let model = session_model(app).await?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let mut session = diarize::build_session(&model)?;
        let all = [Span {
            start_ms: 0,
            end_ms: speech_ms,
        }];
        let (emb, ms) = embed_spans(&mut session, &speech, &all).ok_or_else(|| anyhow!("nothing embeddable"))?;
        save(&app2, &blend(None, emb, ms, "mic-check", true))?;
        log::info!("voiceprint: enrolled from the mic check ({ms} ms)");
        Ok(())
    })
    .await
    .map_err(|e| anyhow!("enroll task: {e}"))?
}

#[tauri::command]
pub fn voiceprint_status(app: AppHandle) -> Option<VoiceprintStatus> {
    load(&app).as_ref().map(VoiceprintStatus::from)
}

#[tauri::command]
pub fn voiceprint_clear(app: AppHandle) -> Result<(), String> {
    match file_path(&app) {
        Ok(p) if p.exists() => std::fs::remove_file(p).map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

/// Enroll (or refine) from one speaker's lines in a recording — the speaker the
/// user just marked as themselves.
#[tauri::command]
pub async fn voiceprint_enroll(app: AppHandle, audio_path: String, spans: Vec<Span>) -> Result<VoiceprintStatus, String> {
    let model = session_model(&app).await.map_err(|e| format!("{e:#}"))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<VoiceprintStatus> {
        let audio = decode_to_16k_mono(Path::new(&audio_path)).context("decode audio")?;
        let mut session = diarize::build_session(&model)?;
        let (emb, ms) = embed_spans(&mut session, &audio, &spans).ok_or_else(|| anyhow!("no line long enough"))?;
        if ms < MIN_ENROLL_MS {
            bail!("only {ms} ms of speech");
        }
        let stored = blend(load(&app2), emb, ms, "marked", false);
        save(&app2, &stored)?;
        log::info!("voiceprint: refined from a marked speaker ({ms} ms, total {} ms)", stored.speech_ms);
        Ok(VoiceprintStatus::from(&stored))
    })
    .await
    .map_err(|e| format!("enroll task: {e}"))?
    .map_err(|e| format!("{e:#}"))
}

/// Each speaker's similarity to the voiceprint; empty when there is none.
#[tauri::command]
pub async fn voiceprint_match(
    app: AppHandle,
    audio_path: String,
    speakers: Vec<SpeakerSpans>,
) -> Result<Vec<SpeakerMatch>, String> {
    let Some(stored) = load(&app) else {
        return Ok(Vec::new());
    };
    let model = session_model(&app).await.map_err(|e| format!("{e:#}"))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SpeakerMatch>> {
        let audio = decode_to_16k_mono(Path::new(&audio_path)).context("decode audio")?;
        let mut session = diarize::build_session(&model)?;
        let mut out = Vec::new();
        for sp in speakers {
            if let Some((emb, ms)) = embed_spans(&mut session, &audio, &sp.spans) {
                out.push(SpeakerMatch {
                    key: sp.key,
                    similarity: diarize::dot(&emb, &stored.embedding),
                    speech_ms: ms,
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("match task: {e}"))?
    .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_moves_toward_the_new_sample_and_caps_the_old_weight() {
        let old = Stored {
            embedding: vec![1.0, 0.0],
            speech_ms: 10_000_000,
            updated_at: 0,
            source: "mic-check".into(),
        };
        let out = blend(Some(old), vec![0.0, 1.0], OLD_WEIGHT_CAP_MS, "marked", false);
        // Equal weights after the cap: halfway between the two directions.
        assert!((out.embedding[0] - out.embedding[1]).abs() < 1e-5);
        assert_eq!(out.source, "marked");
    }

    #[test]
    fn speech_gate_drops_silence() {
        let frame = FRAME_MS * SAMPLES_PER_MS;
        let mut pcm = vec![0i16; frame * 10];
        pcm.extend((0..frame * 10).map(|i| if i % 2 == 0 { 8000 } else { -8000 }));
        assert_eq!(speech_only(&pcm).len(), frame * 10);
    }
}
