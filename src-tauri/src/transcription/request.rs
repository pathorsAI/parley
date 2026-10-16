//! The checks every transcription start must pass — a meeting, a dictation,
//! an upload — in one place. What they check comes from the provider's
//! registry row (its [`Credential`] kind); only the wording of a refusal
//! depends on the entry point, because each one points the user at a
//! different fix.

use super::provider::{Credential, SttProvider};

/// Where a session is started from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    /// A live session: a meeting or a dictation (cloud relay URL).
    Live,
    /// An uploaded recording (cloud batch URL).
    Upload,
}

/// What a caller asks to start, as the start checks need it.
#[derive(Clone, Copy, Debug)]
pub struct SessionRequest<'a> {
    /// What the provider authenticates with. An upload for an id without a
    /// registry row is checked like a vendor key, and refused later as
    /// unsupported.
    pub credential: Credential,
    /// The vendor key, or the cloud session token in hosted mode.
    pub key: &'a str,
    /// The cloud relay (live) or batch (upload) URL, when one was given and
    /// is not blank.
    pub endpoint: Option<&'a str>,
    pub model: Option<&'a str>,
}

impl<'a> SessionRequest<'a> {
    pub fn new(
        provider: Option<SttProvider>,
        key: &'a str,
        endpoint: Option<&'a str>,
        model: Option<&'a str>,
    ) -> Self {
        Self {
            credential: provider.map_or(Credential::ApiKey, |p| p.credential()),
            key,
            endpoint: endpoint.filter(|u| !u.trim().is_empty()),
            model,
        }
    }

    /// Every check, in order, for a live start: credential, endpoint, model.
    /// `installed` fails when an on-device model is not on disk (it reads the
    /// app's paths, so the caller supplies it).
    pub fn validate(
        &self,
        entry: Entry,
        installed: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        self.check_credential(entry)?;
        self.check_endpoint(entry)?;
        self.check_model(installed)
    }

    /// A key (or cloud token) unless the provider runs on-device — the
    /// frontend sends a placeholder for that one.
    pub fn check_credential(&self, entry: Entry) -> Result<(), String> {
        if !self.credential.needs_key() || !self.key.trim().is_empty() {
            return Ok(());
        }
        Err(match entry {
            Entry::Live => "missing transcription API key".to_string(),
            // Hosted mode's credential is the signed-in cloud session, not a
            // pasted key, so this one message has to point at both doors.
            Entry::Upload => "Missing transcription credential — add the provider's API key in Settings, or sign in to Parley Cloud.".to_string(),
        })
    }

    /// Hosted mode's key is the cloud session token, which only the cloud
    /// accepts — sending it straight to a vendor dies with an opaque auth
    /// error. Refuse loudly instead (a call site that forgot the URL is a
    /// frontend bug).
    pub fn check_endpoint(&self, entry: Entry) -> Result<(), String> {
        if self.credential != Credential::CloudSession || self.endpoint.is_some() {
            return Ok(());
        }
        Err(match entry {
            Entry::Live => "hosted transcription requires the cloud relay URL".to_string(),
            Entry::Upload => "hosted transcription requires the cloud batch URL".to_string(),
        })
    }

    /// On-device: fail now, before any work, when the model is not
    /// downloaded — a session that cannot load it would only fail later.
    pub fn check_model(
        &self,
        installed: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.credential == Credential::LocalModel {
            installed(self.model.unwrap_or_default())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYOK: [&str; 5] = ["soniox", "deepgram", "assemblyai", "openai", "gemini"];

    fn request<'a>(id: &str, key: &'a str, endpoint: Option<&'a str>) -> SessionRequest<'a> {
        SessionRequest::new(SttProvider::from_id(id).ok(), key, endpoint, None)
    }

    fn no_model(_: &str) -> Result<(), String> {
        Err("model check reached".to_string())
    }

    fn live(id: &str, key: &str, endpoint: Option<&str>) -> Result<(), String> {
        request(id, key, endpoint).validate(Entry::Live, |_| Ok(()))
    }

    #[test]
    fn a_live_start_without_a_key_is_refused_unless_on_device() {
        for id in BYOK.into_iter().chain(["parley"]) {
            assert_eq!(
                live(id, "  ", Some("wss://relay")),
                Err("missing transcription API key".to_string()),
                "{id}"
            );
            assert_eq!(live(id, "k", Some("wss://relay")), Ok(()), "{id}");
        }
        assert_eq!(live("local", "", None), Ok(()));
    }

    #[test]
    fn hosted_mode_needs_the_relay_and_nothing_else_does() {
        let missing = Err("hosted transcription requires the cloud relay URL".to_string());
        assert_eq!(live("parley", "token", None), missing);
        assert_eq!(live("parley", "token", Some("  ")), missing);
        // The key check comes first.
        assert_eq!(
            live("parley", "", None),
            Err("missing transcription API key".to_string())
        );
        for id in BYOK {
            assert_eq!(live(id, "k", None), Ok(()), "{id}");
        }
    }

    #[test]
    fn only_an_on_device_start_checks_the_model_and_does_so_last() {
        let installed = |model: &str| {
            assert_eq!(model, "whisper-small-q5_1");
            Err("not downloaded".to_string())
        };
        let local = SessionRequest::new(
            SttProvider::from_id("local").ok(),
            "",
            None,
            Some("whisper-small-q5_1"),
        );
        assert_eq!(
            local.validate(Entry::Live, installed),
            Err("not downloaded".to_string())
        );
        // No model given: the check gets "" (the catalog default).
        let local = request("local", "", None);
        let mut asked = None;
        local
            .validate(Entry::Live, |m| {
                asked = Some(m.to_string());
                Ok(())
            })
            .unwrap();
        assert_eq!(asked.as_deref(), Some(""));
        for id in BYOK.into_iter().chain(["parley"]) {
            assert_eq!(
                request(id, "k", Some("u")).validate(Entry::Live, no_model),
                Ok(())
            );
        }
        // A refused key never reaches the model check.
        assert_eq!(
            request("soniox", "", None).validate(Entry::Live, no_model),
            Err("missing transcription API key".to_string())
        );
    }

    #[test]
    fn an_upload_words_its_refusals_for_the_upload_flow() {
        let missing = "Missing transcription credential — add the provider's API key in Settings, or sign in to Parley Cloud.";
        for id in BYOK.into_iter().chain(["parley", "unknown-id"]) {
            assert_eq!(
                request(id, " ", None).check_credential(Entry::Upload),
                Err(missing.to_string()),
                "{id}"
            );
        }
        assert_eq!(
            request("local", "", None).check_credential(Entry::Upload),
            Ok(())
        );
        assert_eq!(
            request("parley", "t", None).check_endpoint(Entry::Upload),
            Err("hosted transcription requires the cloud batch URL".to_string())
        );
        assert_eq!(
            request("parley", "t", Some("https://x/stt/batch")).check_endpoint(Entry::Upload),
            Ok(())
        );
        // An id without a registry row needs no endpoint (it is refused as
        // unsupported at dispatch).
        assert_eq!(
            request("unknown-id", "k", None).check_endpoint(Entry::Upload),
            Ok(())
        );
    }
}
