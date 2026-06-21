//! Audio-based speaker diarization for uploaded recordings.
//!
//! STT speaker diarization is frequently wrong (sides reversed, one person split
//! across several "speakers", two people merged). This module ignores the STT's
//! speaker guesses entirely and re-derives speakers from the *audio itself*:
//!
//!   decode → slice by the existing timestamps → kaldi-fbank features →
//!   CAM++ voice embedding (ONNX) → L2-normalize → cluster → 1 speaker per slice
//!
//! Because it only needs timestamps, it works for ANY STT that returns word/
//! segment times, even ones with no diarization at all. It runs fully locally.
//!
//! Inference uses ONNX Runtime via `ort` with `load-dynamic`: the runtime lives
//! in a bundled `libonnxruntime.dylib` (universal2) located at runtime and
//! exposed through `ORT_DYLIB_PATH`. The ~27 MB speaker model is downloaded once
//! on first use and cached (SHA-256 verified). Feature extraction (`knf-rs`) and
//! clustering are pure Rust. Licenses are clean: ort (MIT/Apache-2.0), knf-rs
//! (MIT), ONNX Runtime (MIT), the 3D-Speaker CAM++ model (Apache-2.0).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use nalgebra::linalg::SymmetricEigen;
use nalgebra::DMatrix;
use ndarray::Axis;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::replay_audio::decode_to_16k_mono;

/// 3D-Speaker CAM++ speaker-verification model (Chinese+English, common-advanced).
/// 192-dim embedding, 80-dim fbank input. Apache-2.0. Input tensor `x`
/// [batch, frames, 80]; output tensor `embedding` [batch, 192]. The model's own
/// metadata declares `feature_normalize_type=global-mean`, which knf-rs already
/// applies (it subtracts the per-utterance mean over time inside `compute_fbank`).
const MODEL_FILE: &str = "campplus_zh_en_16k.onnx";
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
const MODEL_SHA256: &str = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2";
const MODEL_BYTES: u64 = 28_281_164;

/// Model output tensor name (the input tensor is `x`; see the doc comment above).
const OUTPUT_NAME: &str = "embedding";

/// 16 kHz → 16 samples per millisecond.
const SAMPLES_PER_MS: usize = 16;
/// Slices shorter than this give unstable embeddings; we skip embedding them and
/// inherit a neighbour's cluster instead (0.5 s).
const MIN_SLICE_SAMPLES: usize = SAMPLES_PER_MS * 500;
/// Safety cap on auto-detected speaker count.
const KMAX: usize = 8;
/// Auto-K stops merging once the best average-linkage cosine drops below this.
/// Tuned for CAM++ 192-dim embeddings; same-speaker pairs sit well above it.
const MERGE_THRESHOLD: f32 = 0.5;
/// k-means iteration cap (converges far sooner in practice).
const KMEANS_ITERS: usize = 25;

/// NME spectral clustering is used for this segment-count range. Below the floor
/// the eigengap is too noisy (fall back to k-means/agglomerative); above the
/// ceiling the O(P·N³) eigendecompositions get expensive (agglomerative instead).
const NME_MIN_SEGMENTS: usize = 16;
const NME_MAX_SEGMENTS: usize = 800;
/// At most this many `p` (neighbour-count) candidates evaluated in the search.
const NME_MAX_P_CANDIDATES: usize = 16;

/// One transcript segment's id + time span (ms). Mirrors the JS `{id,startMs,endMs}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegSpan {
    id: String,
    start_ms: u64,
    end_ms: u64,
}

/// Speaker assignment for one segment. `speaker` is 1-based (cluster + 1);
/// `confidence` is the cosine margin to the next-nearest cluster centroid (0 for
/// segments that were too short to embed and inherited a neighbour's speaker).
/// Deserialize too, so a cached result can be read back from disk.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegSpeaker {
    id: String,
    speaker: usize,
    confidence: f32,
}

/// Cache identity bump — change when the model or clustering algorithm changes so
/// stale cached diarizations are recomputed.
const CACHE_VERSION: &str = "campplus-nmesc-1";

/// Progress event payload (`diarize://progress`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str,
    received: u64,
    total: u64,
}

/// Cluster an uploaded recording's segments into speakers by voice.
///
/// `num_speakers = Some(k)` forces exactly k clusters (spherical k-means);
/// `None` auto-detects the count (agglomerative cosine clustering, capped at
/// [`KMAX`]). Returns one [`SegSpeaker`] per input segment, in input order.
#[tauri::command]
pub async fn diarize_audio(
    app: AppHandle,
    audio_path: String,
    segments: Vec<SegSpan>,
    num_speakers: Option<usize>,
) -> Result<Vec<SegSpeaker>, String> {
    log::info!(
        "diarize: start segments={} num_speakers={:?}",
        segments.len(),
        num_speakers
    );
    if segments.is_empty() {
        return Err("No segments to diarize".into());
    }

    // Cache: a re-run on the same audio + same spans + same speaker count returns
    // instantly — skipping the model download AND the whole embed/cluster pass.
    let cache_path = cache_key(&audio_path, &segments, num_speakers)
        .and_then(|key| diarize_cache_path(&app, &key));
    if let Some(cp) = &cache_path {
        if let Ok(bytes) = std::fs::read(cp) {
            if let Ok(cached) = serde_json::from_slice::<Vec<SegSpeaker>>(&bytes) {
                log::info!("diarize: cache hit ({} assignments)", cached.len());
                return Ok(cached);
            }
        }
    }

    // The dylib must be located + ORT_DYLIB_PATH set before any ort session, and
    // the model present, both before we hand off to the blocking pipeline.
    locate_and_set_dylib(&app).map_err(|e| format!("{e:#}"))?;
    let model = ensure_model(&app).await.map_err(|e| format!("{e:#}"))?;

    // Decode + fbank + ONNX + clustering are CPU-bound and synchronous — run them
    // off the async runtime so the UI thread stays responsive. The handle lets the
    // pipeline emit staged progress (decoding → embedding i/n → clustering).
    let app_for_pipeline = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_pipeline(app_for_pipeline, model, audio_path, segments, num_speakers)
    })
    .await
    .map_err(|e| format!("diarize task failed: {e}"))?
    .map_err(|e| format!("{e:#}"))?;

    // Cache the result so an identical re-run is free next time.
    if let Some(cp) = &cache_path {
        if let Some(dir) = cp.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec(&result) {
            let _ = std::fs::write(cp, json);
        }
    }

    log::info!("diarize: done assignments={}", result.len());
    Ok(result)
}

/// Cache key for a diarization run: audio identity (name + byte size) + the exact
/// spans + the requested speaker count + the model/algo version. Any real change
/// to those inputs yields a different key (so it recomputes); identical inputs
/// reuse the cached assignment. `None` if the file can't be stat'd.
fn cache_key(audio_path: &str, spans: &[SegSpan], num_speakers: Option<usize>) -> Option<String> {
    let size = std::fs::metadata(audio_path).ok()?.len();
    let name = Path::new(audio_path).file_name()?.to_string_lossy().into_owned();
    let mut hasher = Sha256::new();
    hasher.update(CACHE_VERSION.as_bytes());
    hasher.update(format!("\0{name}\0{size}\0{num_speakers:?}\0").as_bytes());
    for sp in spans {
        hasher.update(format!("{}:{}:{};", sp.id, sp.start_ms, sp.end_ms).as_bytes());
    }
    Some(to_hex(&hasher.finalize()))
}

/// Path of the cached diarization for `key`, in the OS app-cache dir. `None` if
/// there's no cache dir.
fn diarize_cache_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    Some(
        app.path()
            .app_cache_dir()
            .ok()?
            .join("diarizations")
            .join(format!("{key}.json")),
    )
}

/// Decode → embed every long-enough slice → cluster → assign one speaker per
/// segment. Synchronous; intended for `spawn_blocking`.
fn run_pipeline(
    app: AppHandle,
    model: PathBuf,
    audio_path: String,
    spans: Vec<SegSpan>,
    num_speakers: Option<usize>,
) -> Result<Vec<SegSpeaker>> {
    // Staged progress for the UI. `total == 0` means an indeterminate stage.
    let emit = |stage: &'static str, received: u64, total: u64| {
        let _ = app.emit("diarize://progress", Progress { stage, received, total });
    };

    // Decode the whole file once to 16 kHz mono f32 [-1,1]; slice in memory.
    emit("decoding", 0, 0);
    let audio = decode_to_16k_mono(Path::new(&audio_path)).context("decode audio")?;
    if audio.is_empty() {
        bail!("decoded audio was empty");
    }

    // Embedding is embarrassingly parallel — each slice is independent. ONNX
    // Runtime's `Session::run` takes `&mut self`, so instead of sharing one
    // session we give each worker thread its OWN single-threaded session and feed
    // them from a shared ROLLING WORK QUEUE: a worker claims the next unclaimed
    // segment (one atomic fetch_add) the instant it's free, so a slow long segment
    // never makes the others idle — no batch barrier, naturally load-balanced.
    // W workers running 1-intra-thread sessions ≈ W cores busy, no oversubscription.
    // Capped to bound memory (each session holds the ~27 MB model) and skipped for
    // small jobs where the spin-up isn't worth it.
    let n = spans.len();
    let step = (n / 100).max(1); // throttle to ~100 progress events total
    let cores = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(1);
    let workers = if n < 24 { 1 } else { cores.min(8).min(n).max(1) };
    log::info!("diarize: embedding {n} slices across {workers} worker(s)");

    let next = AtomicUsize::new(0); // shared work cursor — the rolling queue
    let processed = AtomicUsize::new(0); // completed count, for progress only
    let mut embeds: Vec<Option<Vec<f32>>> = vec![None; n];

    let worker_results: Vec<Result<Vec<(usize, Vec<f32>)>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                let (spans, audio, model, next, processed, app) =
                    (&spans, &audio, &model, &next, &processed, &app);
                scope.spawn(move || -> Result<Vec<(usize, Vec<f32>)>> {
                    let mut session = build_session(model)?;
                    let mut out: Vec<(usize, Vec<f32>)> = Vec::new();
                    loop {
                        // Claim the next segment; stop when the queue is drained.
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= spans.len() {
                            break;
                        }
                        let sp = &spans[i];
                        let start = (sp.start_ms as usize) * SAMPLES_PER_MS;
                        let end = ((sp.end_ms as usize) * SAMPLES_PER_MS).min(audio.len());
                        if end > start && end - start >= MIN_SLICE_SAMPLES {
                            match embed_slice(&mut session, &audio[start..end]) {
                                Ok(v) => out.push((i, v)),
                                Err(e) => log::warn!("diarize: embed failed for segment {i}: {e:#}"),
                            }
                        }
                        // else: too short / out of range — filled from a neighbour later.
                        let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                        if done % step == 0 || done == n {
                            let _ = app.emit(
                                "diarize://progress",
                                Progress { stage: "embedding", received: done as u64, total: n as u64 },
                            );
                        }
                    }
                    Ok(out)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Ok(Vec::new())))
            .collect()
    });

    // Merge worker outputs. If every worker failed (e.g. the model can't load on
    // any thread), surface that error instead of a misleading "no segments".
    let mut any_ok = false;
    let mut first_err: Option<anyhow::Error> = None;
    for r in worker_results {
        match r {
            Ok(parts) => {
                any_ok = true;
                for (i, v) in parts {
                    embeds[i] = Some(v);
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if !any_ok {
        return Err(first_err
            .unwrap_or_else(|| anyhow!("embedding failed"))
            .context("speaker embedding failed"));
    }

    // Indices that produced an embedding, and the matching embedding matrix.
    let embedded: Vec<usize> = (0..n).filter(|&i| embeds[i].is_some()).collect();
    if embedded.is_empty() {
        bail!("no usable audio segments — every slice was too short or failed to decode");
    }
    let matrix: Vec<Vec<f32>> = embedded
        .iter()
        .map(|&i| embeds[i].take().unwrap())
        .collect();

    // Cluster. NME spectral clustering is the primary method (auto-picks the
    // affinity pruning AND, when unknown, the speaker count via the eigengap).
    // It needs enough segments to be stable, so small/huge jobs fall back to the
    // simpler methods: spherical k-means (known count) / agglomerative (auto).
    emit("clustering", 0, 0);
    let len = matrix.len();
    let use_nme = (NME_MIN_SEGMENTS..=NME_MAX_SEGMENTS).contains(&len);
    let labels = match num_speakers.filter(|&k| k >= 1) {
        Some(k) => {
            let k = k.min(len);
            if k <= 1 {
                vec![0usize; len]
            } else if use_nme {
                nme_spectral(&matrix, Some(k))
            } else {
                spherical_kmeans(&matrix, k)
            }
        }
        None if use_nme => nme_spectral(&matrix, None),
        None => agglomerative(&matrix),
    };
    let k_final = labels.iter().copied().max().map(|m| m + 1).unwrap_or(1);
    let centroids = compute_centroids(&matrix, &labels, k_final);
    log::info!("diarize: {} segments → {} speakers", matrix.len(), k_final);

    // (label, confidence) per segment; embedded ones first.
    let mut assigned: Vec<Option<(usize, f32)>> = vec![None; n];
    for (j, &i) in embedded.iter().enumerate() {
        let conf = margin_confidence(&matrix[j], &centroids, labels[j]);
        assigned[i] = Some((labels[j], conf));
    }

    // Short/failed slices inherit the temporally nearest embedded speaker:
    // carry the last seen label forward, then back-fill any leading gap.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| spans[i].start_ms);
    let mut carry: Option<usize> = None;
    for &i in &order {
        match assigned[i] {
            Some((lab, _)) => carry = Some(lab),
            None => {
                if let Some(lab) = carry {
                    assigned[i] = Some((lab, 0.0));
                }
            }
        }
    }
    let mut back: Option<usize> = None;
    for &i in order.iter().rev() {
        match assigned[i] {
            Some((lab, _)) => back = Some(lab),
            None => {
                if let Some(lab) = back {
                    assigned[i] = Some((lab, 0.0));
                }
            }
        }
    }

    Ok(spans
        .into_iter()
        .enumerate()
        .map(|(i, sp)| {
            let (lab, conf) = assigned[i].unwrap_or((0, 0.0));
            SegSpeaker {
                id: sp.id,
                speaker: lab + 1, // 1-based, matches the LLM re-attribution path
                confidence: conf,
            }
        })
        .collect())
}

/// Build a single-threaded ONNX session for the speaker model. One per worker
/// thread — `with_intra_threads(1)` keeps each session to one core so W parallel
/// workers don't oversubscribe.
fn build_session(model: &Path) -> Result<Session> {
    Session::builder()
        .context("ort session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("ort optimization level")?
        .with_intra_threads(1)
        .context("ort intra threads")?
        .commit_from_file(model)
        .with_context(|| format!("load speaker model {}", model.display()))
}

/// fbank → ONNX embed → L2-normalize for one audio slice.
fn embed_slice(session: &mut Session, slice: &[f32]) -> Result<Vec<f32>> {
    // knf-rs computes 80-dim kaldi fbank and already subtracts the per-utterance
    // mean over time (the model's `global-mean` normalization).
    let feats = knf_rs::compute_fbank(slice).map_err(|e| anyhow!("fbank: {e}"))?;
    if feats.is_empty() {
        bail!("empty fbank");
    }
    let input = feats.insert_axis(Axis(0)); // [frames, 80] → [1, frames, 80]
    let outputs = session.run(ort::inputs!["x" => Tensor::from_array(input)?])?;
    let (_shape, data) = outputs
        .get(OUTPUT_NAME)
        .context("model output 'embedding' missing")?
        .try_extract_tensor::<f32>()?;
    Ok(l2_normalize(data))
}

// ---------------------------------------------------------------------------
// Clustering (pure Rust; embeddings are L2-normalized so cosine == dot product)
// ---------------------------------------------------------------------------

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = dot(v, v).sqrt();
    if norm <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

/// Mean of `members`, L2-normalized (a unit "direction" for the cluster).
fn normalized_mean(members: &[&Vec<f32>]) -> Vec<f32> {
    let dim = members.first().map(|m| m.len()).unwrap_or(0);
    let mut acc = vec![0f32; dim];
    for m in members {
        for (a, x) in acc.iter_mut().zip(m.iter()) {
            *a += x;
        }
    }
    l2_normalize(&acc)
}

fn compute_centroids(matrix: &[Vec<f32>], labels: &[usize], k: usize) -> Vec<Vec<f32>> {
    (0..k)
        .map(|c| {
            let members: Vec<&Vec<f32>> = matrix
                .iter()
                .zip(labels)
                .filter(|(_, &l)| l == c)
                .map(|(v, _)| v)
                .collect();
            if members.is_empty() {
                vec![0f32; matrix.first().map(|v| v.len()).unwrap_or(0)]
            } else {
                normalized_mean(&members)
            }
        })
        .collect()
}

/// Cosine margin between a point's own centroid and its nearest other centroid,
/// clamped to [0, 1]. Higher = more confidently in its cluster.
fn margin_confidence(point: &[f32], centroids: &[Vec<f32>], own: usize) -> f32 {
    if centroids.len() <= 1 {
        return 1.0;
    }
    let s_own = dot(point, &centroids[own]);
    let s_other = centroids
        .iter()
        .enumerate()
        .filter(|(c, _)| *c != own)
        .map(|(_, c)| dot(point, c))
        .fold(f32::MIN, f32::max);
    (s_own - s_other).clamp(0.0, 1.0)
}

/// Spherical k-means with deterministic farthest-first initialization. Returns a
/// cluster label in [0, k) per row. `k` is assumed ≥ 2 and ≤ matrix.len().
fn spherical_kmeans(matrix: &[Vec<f32>], k: usize) -> Vec<usize> {
    let n = matrix.len();
    // Farthest-first seeding: start at 0, then repeatedly take the point least
    // similar to all chosen centroids. Deterministic (no RNG → reproducible).
    let mut centroids: Vec<Vec<f32>> = vec![matrix[0].clone()];
    while centroids.len() < k {
        let mut best_i = 0;
        let mut best_dist = f32::MIN; // distance = 1 - max cos to chosen
        for (i, v) in matrix.iter().enumerate() {
            let max_sim = centroids.iter().map(|c| dot(v, c)).fold(f32::MIN, f32::max);
            let dist = 1.0 - max_sim;
            if dist > best_dist {
                best_dist = dist;
                best_i = i;
            }
        }
        centroids.push(matrix[best_i].clone());
    }

    let mut labels = vec![0usize; n];
    for _ in 0..KMEANS_ITERS {
        let mut changed = false;
        for (i, v) in matrix.iter().enumerate() {
            let lab = (0..k)
                .max_by(|&a, &b| dot(v, &centroids[a]).total_cmp(&dot(v, &centroids[b])))
                .unwrap_or(0);
            if lab != labels[i] {
                changed = true;
                labels[i] = lab;
            }
        }
        // Recompute centroids; re-seed any emptied cluster with the point
        // farthest from its current centroid so k clusters stay populated.
        for c in 0..k {
            let members: Vec<&Vec<f32>> = matrix
                .iter()
                .zip(&labels)
                .filter(|(_, &l)| l == c)
                .map(|(v, _)| v)
                .collect();
            if members.is_empty() {
                // Reseed an emptied cluster with the worst-fitting point overall
                // (lowest similarity to its own current centroid) and steal it.
                drop(members);
                if let Some(worst) = (0..n).min_by(|&a, &b| {
                    dot(&matrix[a], &centroids[labels[a]])
                        .total_cmp(&dot(&matrix[b], &centroids[labels[b]]))
                }) {
                    labels[worst] = c;
                    centroids[c] = matrix[worst].clone();
                }
            } else {
                centroids[c] = normalized_mean(&members);
            }
        }
        if !changed {
            break;
        }
    }
    labels
}

/// Agglomerative average-linkage clustering on cosine similarity. Merges the most
/// similar clusters until the best average-linkage similarity drops below
/// [`MERGE_THRESHOLD`], then keeps merging (if needed) down to [`KMAX`]. Returns
/// dense labels in [0, k).
fn agglomerative(matrix: &[Vec<f32>]) -> Vec<usize> {
    let n = matrix.len();
    if n == 1 {
        return vec![0];
    }

    // Pairwise item similarities.
    let mut sim = vec![vec![0f32; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let s = dot(&matrix[i], &matrix[j]);
            sim[i][j] = s;
            sim[j][i] = s;
        }
    }

    // Active clusters as member-index lists, plus cross-cluster similarity SUMS
    // (average linkage = sum / (|A|*|B|)). `members[c]` empty ⇒ cluster merged away.
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut sumsim = sim.clone(); // sumsim[a][b] starts as the single-pair sim
    let mut active: Vec<usize> = (0..n).collect();

    while active.len() > 1 {
        // Best mergeable pair by average linkage.
        let (mut ba, mut bb, mut best) = (0usize, 0usize, f32::MIN);
        for ia in 0..active.len() {
            for ib in (ia + 1)..active.len() {
                let a = active[ia];
                let b = active[ib];
                let avg = sumsim[a][b] / (members[a].len() * members[b].len()) as f32;
                if avg > best {
                    best = avg;
                    ba = a;
                    bb = b;
                }
            }
        }

        let must_reduce = active.len() > KMAX;
        if !must_reduce && best < MERGE_THRESHOLD {
            break;
        }

        // Merge bb into ba: combine members and fold similarity sums.
        let moved = std::mem::take(&mut members[bb]);
        members[ba].extend(moved);
        for &c in &active {
            if c != ba && c != bb {
                let s = sumsim[ba][c] + sumsim[bb][c];
                sumsim[ba][c] = s;
                sumsim[c][ba] = s;
            }
        }
        active.retain(|&c| c != bb);
    }

    // Densify: active cluster id → 0..k.
    let mut labels = vec![0usize; n];
    for (new_label, &c) in active.iter().enumerate() {
        for &m in &members[c] {
            labels[m] = new_label;
        }
    }
    labels
}

// ---------------------------------------------------------------------------
// NME spectral clustering (Auto-Tuning Spectral Clustering, normalized max
// eigengap — Park/Han/Kumar/Narayanan). Auto-selects both the affinity pruning
// and (when unknown) the speaker count, which removes the hand-set cosine
// threshold + speaker cap that the agglomerative path relies on.
// ---------------------------------------------------------------------------

/// Cluster L2-normalized embeddings with NME-SC. `known_k = Some(k)` forces k
/// clusters; `None` estimates the count from the eigengap. Returns a dense label
/// per row. Intended for `matrix.len()` within [NME_MIN, NME_MAX] (the caller
/// gates this; outside that range the eigengap is noisy or the eig too costly).
fn nme_spectral(matrix: &[Vec<f32>], known_k: Option<usize>) -> Vec<usize> {
    let n = matrix.len();
    if n < 2 {
        return vec![0usize; n];
    }
    let aff = cosine_affinity(matrix);
    let max_k = KMAX.min(n - 1).max(1);

    // Search the neighbour count p: keep the p whose pruned affinity yields the
    // cleanest spectrum, scored r(p) = p / g(p) with g the normalized max eigengap.
    // Each p is an independent eigendecomposition → workers pull from a shared
    // rolling queue (claim next p when free), same load-balanced pattern as the
    // embedding loop — no fixed chunk that could leave a worker idle.
    let p_max = (n / 4).clamp(2, n - 1);
    let cands = p_candidates(p_max, NME_MAX_P_CANDIDATES);
    let workers = num_workers(cands.len());
    let cursor = AtomicUsize::new(0);

    let scored: Vec<(usize, f32, usize)> = std::thread::scope(|scope| {
        let (aff, cands, cursor) = (&aff, &cands, &cursor);
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(move || {
                    let mut local: Vec<(usize, f32, usize)> = Vec::new();
                    loop {
                        let idx = cursor.fetch_add(1, Ordering::Relaxed);
                        if idx >= cands.len() {
                            break;
                        }
                        let p = cands[idx];
                        let lap = pruned_laplacian(aff, p);
                        let mut evals: Vec<f64> =
                            lap.symmetric_eigenvalues().iter().copied().collect();
                        evals.sort_by(|a, b| a.total_cmp(b));
                        let (g, k_est) = nme_and_count(&evals, max_k);
                        let r = if g > 0.0 { p as f32 / g as f32 } else { f32::INFINITY };
                        local.push((p, r, k_est));
                    }
                    local
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });

    let (best_p, _, k_est) = scored
        .into_iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap_or((1, f32::INFINITY, known_k.unwrap_or(2)));

    let k = known_k.unwrap_or(k_est).clamp(1, n);
    if k <= 1 {
        return vec![0usize; n];
    }

    // Final decomposition at the chosen p → NJW spectral embedding (k smallest
    // eigenvectors, row-normalized) → k-means.
    let lap = pruned_laplacian(&aff, best_p);
    let se = SymmetricEigen::new(lap);
    let spec = spectral_embedding(&se, k);
    kmeans_euclidean(&spec, k)
}

/// N×N cosine affinity (embeddings are L2-normalized, so this is a dot product),
/// diagonal 1.
fn cosine_affinity(matrix: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let n = matrix.len();
    let mut aff = vec![vec![0f32; n]; n];
    for i in 0..n {
        aff[i][i] = 1.0;
        for j in (i + 1)..n {
            let s = dot(&matrix[i], &matrix[j]);
            aff[i][j] = s;
            aff[j][i] = s;
        }
    }
    aff
}

/// p-neighbour binarized + symmetrized affinity → symmetric NORMALIZED Laplacian
/// L_sym = I − D^{-1/2} A D^{-1/2}. Each row keeps its p strongest off-diagonal
/// neighbours (=1, others 0); the average-symmetrization denoises spurious
/// cross-speaker links — the mechanism that lets NME-SC beat a fixed threshold on
/// short noisy turns. The normalized Laplacian (eigenvalues in [0, 2]) gives a far
/// cleaner eigengap for count estimation than the unnormalized D − A.
fn pruned_laplacian(aff: &[Vec<f32>], p: usize) -> DMatrix<f64> {
    let n = aff.len();
    let mut bin = vec![vec![0f32; n]; n];
    let mut idx: Vec<usize> = Vec::with_capacity(n);
    for i in 0..n {
        idx.clear();
        idx.extend((0..n).filter(|&j| j != i));
        idx.sort_by(|&a, &b| aff[i][b].total_cmp(&aff[i][a]));
        for &j in idx.iter().take(p) {
            bin[i][j] = 1.0;
        }
    }
    // Symmetrized affinity A and degrees.
    let mut sym = vec![vec![0f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            sym[i][j] = (0.5 * (bin[i][j] + bin[j][i])) as f64;
        }
    }
    let deg: Vec<f64> = (0..n).map(|i| sym[i].iter().sum()).collect();
    DMatrix::from_fn(n, n, |i, j| {
        if i == j {
            if deg[i] > 0.0 {
                1.0
            } else {
                0.0
            }
        } else if deg[i] > 0.0 && deg[j] > 0.0 {
            -sym[i][j] / (deg[i] * deg[j]).sqrt()
        } else {
            0.0
        }
    })
}

/// Normalized maximum eigengap g and the speaker count it implies. `evals` is
/// ascending. g = (largest gap among the first `max_k`) / (largest eigenvalue);
/// count = the position of that gap (# eigenvalues below it).
fn nme_and_count(evals: &[f64], max_k: usize) -> (f64, usize) {
    let n = evals.len();
    if n < 2 {
        return (0.0, 1);
    }
    let lambda_max = evals[n - 1].max(1e-12);
    let upper = max_k.min(n - 1).max(1);
    let mut best_gap = f64::MIN;
    let mut best_k = 1;
    for k in 1..=upper {
        let gap = evals[k] - evals[k - 1];
        if gap > best_gap {
            best_gap = gap;
            best_k = k;
        }
    }
    ((best_gap / lambda_max).max(0.0), best_k)
}

/// NJW spectral embedding: the `k` eigenvectors with smallest eigenvalues, one
/// row per node, each row L2-normalized.
fn spectral_embedding(se: &SymmetricEigen<f64, nalgebra::Dyn>, k: usize) -> Vec<Vec<f32>> {
    let n = se.eigenvalues.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| se.eigenvalues[a].total_cmp(&se.eigenvalues[b]));
    let cols = &order[..k.min(n)];
    (0..n)
        .map(|i| {
            let mut row: Vec<f32> = cols.iter().map(|&c| se.eigenvectors[(i, c)] as f32).collect();
            let norm = dot(&row, &row).sqrt();
            if norm > f32::EPSILON {
                for v in &mut row {
                    *v /= norm;
                }
            }
            row
        })
        .collect()
}

/// Euclidean k-means with deterministic farthest-first init (`k >= 2`).
fn kmeans_euclidean(points: &[Vec<f32>], k: usize) -> Vec<usize> {
    let n = points.len();
    let dim = points.first().map(|p| p.len()).unwrap_or(0);

    let mut centroids: Vec<Vec<f32>> = vec![points[0].clone()];
    while centroids.len() < k {
        let mut best_i = 0;
        let mut best_d = f32::MIN;
        for (i, pt) in points.iter().enumerate() {
            let d = centroids.iter().map(|c| sqdist(pt, c)).fold(f32::INFINITY, f32::min);
            if d > best_d {
                best_d = d;
                best_i = i;
            }
        }
        centroids.push(points[best_i].clone());
    }

    let mut labels = vec![0usize; n];
    for _ in 0..KMEANS_ITERS {
        let mut changed = false;
        for (i, pt) in points.iter().enumerate() {
            let lab = (0..k)
                .min_by(|&a, &b| sqdist(pt, &centroids[a]).total_cmp(&sqdist(pt, &centroids[b])))
                .unwrap_or(0);
            if lab != labels[i] {
                changed = true;
                labels[i] = lab;
            }
        }
        for c in 0..k {
            let members: Vec<&Vec<f32>> = points
                .iter()
                .zip(&labels)
                .filter(|(_, &l)| l == c)
                .map(|(p, _)| p)
                .collect();
            if members.is_empty() {
                drop(members);
                if let Some(worst) = (0..n).max_by(|&a, &b| {
                    sqdist(&points[a], &centroids[labels[a]])
                        .total_cmp(&sqdist(&points[b], &centroids[labels[b]]))
                }) {
                    labels[worst] = c;
                    centroids[c] = points[worst].clone();
                }
            } else {
                let mut mean = vec![0f32; dim];
                for m in &members {
                    for (a, x) in mean.iter_mut().zip(m.iter()) {
                        *a += x;
                    }
                }
                for a in &mut mean {
                    *a /= members.len() as f32;
                }
                centroids[c] = mean;
            }
        }
        if !changed {
            break;
        }
    }
    labels
}

fn sqdist(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum()
}

/// Up to `cap` distinct neighbour-count candidates spread over [1, p_max].
fn p_candidates(p_max: usize, cap: usize) -> Vec<usize> {
    if p_max <= cap {
        return (1..=p_max).collect();
    }
    let mut out: Vec<usize> = Vec::with_capacity(cap);
    for i in 0..cap {
        let p = 1 + (i * (p_max - 1)) / (cap - 1);
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    out
}

/// Worker count for the small parallel p-search, bounded by cores and items.
fn num_workers(items: usize) -> usize {
    std::thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(1)
        .min(8)
        .min(items)
        .max(1)
}

// ---------------------------------------------------------------------------
// Runtime + model acquisition
// ---------------------------------------------------------------------------

/// Locate `libonnxruntime.dylib` and point `ORT_DYLIB_PATH` at it. Checks the
/// bundled resource dir (release) first, then the crate-local `onnxruntime/` dir
/// (dev, populated by `scripts/fetch-onnxruntime.sh`). The dylib is intentionally
/// bundled rather than downloaded — it's the core runtime.
fn locate_and_set_dylib(app: &AppHandle) -> Result<PathBuf> {
    let candidates = [
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("onnxruntime").join("libonnxruntime.dylib")),
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("onnxruntime")
                .join("libonnxruntime.dylib"),
        ),
    ];
    for cand in candidates.into_iter().flatten() {
        if cand.exists() {
            std::env::set_var("ORT_DYLIB_PATH", &cand);
            log::info!("diarize: ORT_DYLIB_PATH={}", cand.display());
            return Ok(cand);
        }
    }
    bail!(
        "ONNX Runtime library not found. In development run \
         `src-tauri/scripts/fetch-onnxruntime.sh`; release builds bundle it."
    )
}

/// Ensure the speaker model is present + intact, downloading it once on first use
/// to `app_data_dir()/models/`. Verifies SHA-256; a stale/partial file is
/// re-downloaded. Emits `diarize://progress` while downloading.
async fn ensure_model(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("resolve app data dir")?
        .join("models");
    std::fs::create_dir_all(&dir).context("create models dir")?;
    let path = dir.join(MODEL_FILE);

    if path.exists() {
        match file_sha256(&path) {
            Ok(sum) if sum == MODEL_SHA256 => return Ok(path),
            Ok(_) => log::warn!("diarize: cached model checksum mismatch, re-downloading"),
            Err(e) => log::warn!("diarize: cannot hash cached model ({e}), re-downloading"),
        }
    }

    log::info!("diarize: downloading speaker model (~27 MB)…");
    let resp = reqwest::get(MODEL_URL)
        .await
        .context("request speaker model")?
        .error_for_status()
        .context("speaker model download")?;
    let total = resp.content_length().unwrap_or(MODEL_BYTES);

    let tmp = path.with_extension("part");
    let mut file = std::fs::File::create(&tmp).context("create model temp file")?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download model chunk")?;
        std::io::Write::write_all(&mut file, &chunk).context("write model chunk")?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        let _ = app.emit(
            "diarize://progress",
            Progress { stage: "downloading-model", received, total },
        );
    }
    drop(file);

    let got = to_hex(&hasher.finalize());
    if got != MODEL_SHA256 {
        let _ = std::fs::remove_file(&tmp);
        bail!("speaker model checksum mismatch (expected {MODEL_SHA256}, got {got})");
    }
    std::fs::rename(&tmp, &path).context("finalize model file")?;
    log::info!("diarize: speaker model ready ({} bytes)", received);
    Ok(path)
}

/// SHA-256 of a file as lowercase hex, read in chunks.
fn file_sha256(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NME-SC on two well-separated speaker-like blobs (realistic within-speaker
    /// spread, not degenerate near-identical points) must auto-detect 2 speakers
    /// and split them, and respect a forced count. Pure clustering (no model/dylib)
    /// so it runs in normal `cargo test`. Deterministic LCG noise → reproducible.
    fn blob(center: &[f32], rng: &mut u64, noise: f32) -> Vec<f32> {
        let mut v: Vec<f32> = center
            .iter()
            .map(|&c| {
                *rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let u = ((*rng >> 40) as f32 / (1u64 << 23) as f32) - 1.0; // ~[-1,1)
                c + noise * u
            })
            .collect();
        let norm = dot(&v, &v).sqrt();
        for x in &mut v {
            *x /= norm;
        }
        v
    }

    #[test]
    fn nme_spectral_separates_two_blobs() {
        let dim = 32;
        let mut ca = vec![0f32; dim];
        let mut cb = vec![0f32; dim];
        for d in 0..16 {
            ca[d] = 1.0; // speaker A lives in the first-16 subspace
            cb[d + 16] = 1.0; // speaker B in the last-16 subspace
        }
        let mut rng: u64 = 0x0123_4567_89ab_cdef;
        let mut matrix: Vec<Vec<f32>> = Vec::new();
        for _ in 0..20 {
            matrix.push(blob(&ca, &mut rng, 0.35));
        }
        for _ in 0..20 {
            matrix.push(blob(&cb, &mut rng, 0.35));
        }

        let labels = nme_spectral(&matrix, None);
        let k = labels.iter().copied().max().unwrap() + 1;
        assert_eq!(k, 2, "should auto-detect 2 speakers, got {k}");
        assert!(labels[..20].iter().all(|&l| l == labels[0]), "blob A should be one cluster");
        assert!(labels[20..].iter().all(|&l| l == labels[20]), "blob B should be one cluster");
        assert_ne!(labels[0], labels[20], "the two blobs must differ");

        let forced = nme_spectral(&matrix, Some(2));
        assert!(forced[..20].iter().all(|&l| l == forced[0]));
        assert!(forced[20..].iter().all(|&l| l == forced[20]));
        assert_ne!(forced[0], forced[20]);
    }

    fn dev_dylib() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("onnxruntime/libonnxruntime.dylib")
    }

    /// Locally-cached model for the test (download once to /tmp, or set
    /// PARLEY_TEST_MODEL). The test self-skips when neither is available so CI
    /// without the assets stays green.
    fn test_model() -> Option<PathBuf> {
        let p = std::env::var("PARLEY_TEST_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp/campplus.onnx"));
        p.exists().then_some(p)
    }

    fn tone(freq: f32, secs: f32) -> Vec<f32> {
        let n = (16_000.0 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * (i as f32) / 16_000.0).sin() * 0.3)
            .collect()
    }

    /// End-to-end exercise of the real ORT dylib + real CAM++ model: validates
    /// the dylib loads, the `x`/`embedding` tensor names and shapes are right,
    /// fbank feeds correctly, the embedding is 192-d & finite & deterministic,
    /// and the clustering separates clearly-different inputs.
    ///
    /// `#[ignore]`d by default: it needs the local dylib + a cached model, and
    /// ONNX Runtime has a known crash in its global-environment destructor at
    /// process exit (fires *after* the test logic, harmless to the running app).
    /// Run it on demand: `cargo test -- --ignored embed_and_cluster_end_to_end`.
    #[test]
    #[ignore = "needs local ONNX Runtime dylib + model; ort crashes on process-exit teardown"]
    fn embed_and_cluster_end_to_end() {
        let (Some(model), dylib) = (test_model(), dev_dylib()) else {
            eprintln!("test model unavailable; skipping");
            return;
        };
        if !dylib.exists() {
            eprintln!("dev dylib unavailable; skipping");
            return;
        }
        std::env::set_var("ORT_DYLIB_PATH", &dylib);

        let mut session = build_session(&model).unwrap();

        let a = embed_slice(&mut session, &tone(180.0, 2.0)).unwrap();
        let a2 = embed_slice(&mut session, &tone(180.0, 2.0)).unwrap();
        let b = embed_slice(&mut session, &tone(320.0, 2.0)).unwrap();
        let b2 = embed_slice(&mut session, &tone(320.0, 2.0)).unwrap();

        assert_eq!(a.len(), 192, "embedding must be 192-dim");
        assert!(a.iter().all(|x| x.is_finite()), "embedding must be finite");
        assert!((dot(&a, &a) - 1.0).abs() < 1e-3, "L2-normalized → self-cosine ~1");

        // Identical input is more similar to itself than a different tone is.
        let sim_same = dot(&a, &a2);
        let sim_diff = dot(&a, &b);
        eprintln!("sim_same={sim_same:.4} sim_diff={sim_diff:.4}");
        assert!(sim_same > sim_diff, "same input should be most similar");

        // K=2 over {A, A, B, B} must put the two A's together, apart from the B's.
        let labels = spherical_kmeans(&[a, a2, b, b2], 2);
        assert_eq!(labels[0], labels[1], "the two A slices should share a cluster");
        assert_eq!(labels[2], labels[3], "the two B slices should share a cluster");
        assert_ne!(labels[0], labels[2], "A and B should be different clusters");
    }
}
