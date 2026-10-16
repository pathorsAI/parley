//! The STT provider registry: one [`ProviderSpec`] row per provider, holding
//! everything the rest of the app needs to know about it — its id, default
//! model, what credential it takes, whether it diarizes, its live session
//! entry point, and how uploads are transcribed and cached. Start checks,
//! dispatch, the upload cache and the usage log all read the row instead of
//! matching on the provider.
//!
//! Adding a provider: write its adapter module (a `run_session` with the
//! shared signature, plus a `transcribe_file` taking a
//! [`BatchRequest`](super::batch::BatchRequest) if it can transcribe uploads),
//! declare it in `transcription/mod.rs`, and add a row to [`PROVIDERS`].

use std::fmt;

use anyhow::{anyhow, Result};
use futures_util::future::BoxFuture;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::batch::BatchFn;
use super::common::TranscribeConfig;
use super::{assemblyai, deepgram, gemini, local, openai, parley, soniox};

/// What a provider needs to authenticate a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Credential {
    /// The user's own vendor key (BYOK).
    ApiKey,
    /// The signed-in Parley Cloud session token. Only the cloud accepts it, so
    /// the caller must also pass the cloud's relay URL (live) or batch URL
    /// (uploads).
    CloudSession,
    /// Nothing to send: an on-device model, which must be downloaded first.
    LocalModel,
}

impl Credential {
    /// Whether a session needs a non-empty key (or cloud token) from the caller.
    pub fn needs_key(self) -> bool {
        self != Credential::LocalModel
    }
}

/// A provider's live session entry point: stream PCM from the receiver,
/// emitting transcript segments tagged with the source label, until the input
/// closes (`Ok`) or the session fails (`Err`).
pub type LiveSession = fn(
    AppHandle,
    TranscribeConfig,
    &'static str,
    UnboundedReceiver<Vec<i16>>,
) -> BoxFuture<'static, Result<()>>;

/// How a provider transcribes an uploaded recording.
pub enum Batch {
    /// Compress, upload and transcribe through the provider's batch API.
    Upload(BatchFn),
    /// Decode the original file on this machine (no upload, no compression).
    OnDevice,
}

/// How an upload's cache file is named after its provider. The names are on
/// users' disks, so a provider's naming never changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadCache {
    /// `{file}-{size}.json` — the first provider kept its original names.
    Unsuffixed,
    /// `{file}-{size}-{id}.json`.
    ById,
    /// `{file}-{size}-{id}-{model}.json`: results depend on which on-device
    /// model ran (the model as `local_stt::resolve_model_id` resolves it).
    ByLocalModel,
}

/// One provider's registry row.
pub struct ProviderSpec {
    /// Stable id used by the frontend, the usage log and the upload cache.
    pub id: &'static str,
    /// Realtime model when the caller supplies none ("" = the provider has a
    /// single model, or picks it itself).
    pub default_model: &'static str,
    pub credential: Credential,
    /// Whether the provider can label speakers. Drives whether the UI offers
    /// per-speaker naming, and whether a meeting mixes both sides into one
    /// session.
    pub diarization: bool,
    pub live: LiveSession,
    /// `None`: uploads cannot be transcribed with this provider.
    pub batch: Option<Batch>,
    pub upload_cache: UploadCache,
}

impl ProviderSpec {
    /// The provider part of an upload's cache file name (`None` = no suffix).
    pub fn upload_cache_suffix(&self, model: Option<&str>) -> Option<String> {
        match self.upload_cache {
            UploadCache::Unsuffixed => None,
            UploadCache::ById => Some(self.id.to_string()),
            UploadCache::ByLocalModel => Some(format!(
                "{}-{}",
                self.id,
                crate::local_stt::resolve_model_id(model.unwrap_or_default())
            )),
        }
    }
}

/// Every provider the app can transcribe with.
pub static PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "soniox",
        default_model: "stt-rt-v5",
        credential: Credential::ApiKey,
        diarization: true,
        live: |app, config, source, pcm| Box::pin(soniox::run_session(app, config, source, pcm)),
        batch: Some(Batch::Upload(|req| Box::pin(soniox::transcribe_file(req)))),
        upload_cache: UploadCache::Unsuffixed,
    },
    ProviderSpec {
        id: "deepgram",
        default_model: "nova-3",
        credential: Credential::ApiKey,
        diarization: true,
        live: |app, config, source, pcm| Box::pin(deepgram::run_session(app, config, source, pcm)),
        batch: Some(Batch::Upload(|req| {
            Box::pin(deepgram::transcribe_file(req))
        })),
        upload_cache: UploadCache::ById,
    },
    ProviderSpec {
        id: "assemblyai",
        // A single streaming model, no id needed.
        default_model: "",
        credential: Credential::ApiKey,
        diarization: false,
        live: |app, config, source, pcm| {
            Box::pin(assemblyai::run_session(app, config, source, pcm))
        },
        batch: Some(Batch::Upload(|req| {
            Box::pin(assemblyai::transcribe_file(req))
        })),
        upload_cache: UploadCache::ById,
    },
    ProviderSpec {
        id: "openai",
        default_model: "gpt-4o-transcribe",
        credential: Credential::ApiKey,
        diarization: false,
        live: |app, config, source, pcm| Box::pin(openai::run_session(app, config, source, pcm)),
        batch: Some(Batch::Upload(|req| Box::pin(openai::transcribe_file(req)))),
        upload_cache: UploadCache::ById,
    },
    ProviderSpec {
        id: "gemini",
        default_model: "gemini-2.0-flash-live-001",
        credential: Credential::ApiKey,
        diarization: false,
        live: |app, config, source, pcm| Box::pin(gemini::run_session(app, config, source, pcm)),
        batch: Some(Batch::Upload(|req| Box::pin(gemini::transcribe_file(req)))),
        upload_cache: UploadCache::ById,
    },
    // Hosted account mode: Parley Cloud's own streaming protocol (cloud WSS
    // URL + Bearer session token, no provider key) — see
    // `TranscribeConfig::relay_endpoint` and `parley::run_session`. The cloud
    // picks the model (the protocol carries none) and diarizes on request
    // (the `start` frame's flag).
    ProviderSpec {
        id: "parley",
        default_model: "",
        credential: Credential::CloudSession,
        diarization: true,
        live: |app, config, source, pcm| Box::pin(parley::run_session(app, config, source, pcm)),
        batch: Some(Batch::Upload(|req| Box::pin(parley::transcribe_file(req)))),
        upload_cache: UploadCache::ById,
    },
    // On-device whisper.cpp — no network, no key; `model` is a catalog id
    // from `local_stt::CATALOG`. See `local::run_session`.
    ProviderSpec {
        id: "local",
        default_model: crate::local_stt::DEFAULT_MODEL_ID,
        credential: Credential::LocalModel,
        diarization: false,
        live: |app, config, source, pcm| Box::pin(local::run_session(app, config, source, pcm)),
        batch: Some(Batch::OnDevice),
        upload_cache: UploadCache::ByLocalModel,
    },
];

/// The registry row for `id` (exact match), if there is one.
pub fn spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Which transcription backend to route audio through: a handle on its
/// registry row.
#[derive(Clone, Copy)]
pub struct SttProvider(&'static ProviderSpec);

impl SttProvider {
    /// Parse the frontend's provider id. Falls back to an error so callers can
    /// surface a clear message rather than silently picking a default.
    pub fn from_id(id: &str) -> Result<Self> {
        spec(id)
            .map(Self)
            .ok_or_else(|| anyhow!("unknown stt provider: {id}"))
    }

    pub fn spec(&self) -> &'static ProviderSpec {
        self.0
    }

    /// Stable string id used by the frontend and the usage log.
    pub fn id(&self) -> &'static str {
        self.0.id
    }

    /// Default realtime model id when the caller doesn't supply one.
    pub fn default_model(&self) -> &'static str {
        self.0.default_model
    }

    /// Whether this backend can label speakers.
    pub fn supports_diarization(&self) -> bool {
        self.0.diarization
    }

    pub fn credential(&self) -> Credential {
        self.0.credential
    }
}

impl PartialEq for SttProvider {
    fn eq(&self, other: &Self) -> bool {
        self.0.id == other.0.id
    }
}

impl Eq for SttProvider {}

impl fmt::Debug for SttProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SttProvider").field(&self.0.id).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_unique() {
        for (i, a) in PROVIDERS.iter().enumerate() {
            for b in &PROVIDERS[i + 1..] {
                assert_ne!(a.id, b.id);
            }
        }
    }

    #[test]
    fn only_the_cloud_takes_a_session_and_only_local_takes_no_key() {
        let by = |c: Credential| -> Vec<&str> {
            PROVIDERS
                .iter()
                .filter(|p| p.credential == c)
                .map(|p| p.id)
                .collect()
        };
        assert_eq!(by(Credential::CloudSession), vec!["parley"]);
        assert_eq!(by(Credential::LocalModel), vec!["local"]);
        assert!(!Credential::LocalModel.needs_key());
        assert!(Credential::ApiKey.needs_key() && Credential::CloudSession.needs_key());
    }
}
