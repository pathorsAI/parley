//! Structured session errors and the error codes a failed session raises.
//!
//! An adapter that knows WHY a session failed — the provider refused the key,
//! the hosted quota is used up, the on-device model is missing — returns an
//! [`SttError`] of that [`SttErrorKind`]; its message is exactly the text the
//! adapter always produced, so what the user reads does not change. The
//! session (`capture::run_metered_session`) turns a failure into the code the
//! frontend branches on with [`session_error_code`]: from the kind when there
//! is one, and from the message text otherwise ([`classify_message`], the
//! classifier every failure used to go through), so an error nobody has
//! structured yet keeps its code.

use std::fmt;

/// Why a session failed, as far as the adapter can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SttErrorKind {
    /// The provider refused the credential (HTTP 401): a rejected vendor key,
    /// or an expired cloud session.
    Unauthorized,
    /// The provider refused the request (HTTP 403).
    Forbidden,
    /// Out of hosted quota (HTTP 402, the cloud's `quota_exceeded`).
    QuotaExceeded,
    /// The on-device model is not downloaded.
    ModelMissing,
    /// The on-device model could not be loaded for lack of memory.
    OutOfMemory,
    /// Any other on-device failure.
    Local,
}

impl SttErrorKind {
    /// The `meeting://error` / `voicetyping://error` code for this kind.
    /// `hosted`: the session ran through the Parley Cloud relay, where a 401
    /// means "sign in again" and a 402 "out of credits" — whereas BYOK fails on
    /// a rejected vendor key (401/403), where telling the user to "sign in" is
    /// wrong and the fix is the key in Settings. A refusal with no fix on our
    /// side is "connect", which a meeting redials through. On-device failures
    /// are final either way: a redial would fail the same way.
    pub fn code(self, hosted: bool) -> &'static str {
        match (self, hosted) {
            (Self::ModelMissing, _) => "local-missing",
            (Self::OutOfMemory, _) => "local-memory",
            (Self::Local, _) => "local",
            (Self::QuotaExceeded, true) => "quota",
            (Self::Unauthorized, true) => "auth",
            (Self::Unauthorized | Self::Forbidden, false) => "key",
            (Self::QuotaExceeded, false) | (Self::Forbidden, true) => "connect",
        }
    }
}

/// A session failure of a known [`SttErrorKind`]. Displays as its message
/// alone, so wrapping a failure in it never changes the text that surfaces.
#[derive(Debug)]
pub struct SttError {
    pub kind: SttErrorKind,
    message: String,
}

impl SttError {
    pub fn new(kind: SttErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The failure of a request the provider answered with HTTP `status`:
    /// structured when the status says why (401 / 402 / 403), a plain error
    /// with `message` otherwise.
    pub fn from_status(status: u16, message: String) -> anyhow::Error {
        let kind = match status {
            401 => SttErrorKind::Unauthorized,
            402 => SttErrorKind::QuotaExceeded,
            403 => SttErrorKind::Forbidden,
            _ => return anyhow::anyhow!(message),
        };
        Self::new(kind, message).into()
    }

    /// An on-device failure. The local catalog's errors start with "Local
    /// transcription" and name their kind (`local_stt::failure_code`); any
    /// other text (a path that could not be resolved, say) stays a plain error.
    pub fn local(message: String) -> anyhow::Error {
        if !message.to_lowercase().starts_with("local transcription") {
            return anyhow::anyhow!(message);
        }
        let kind = match crate::local_stt::failure_code(&message) {
            "local-missing" => SttErrorKind::ModelMissing,
            "local-memory" => SttErrorKind::OutOfMemory,
            _ => SttErrorKind::Local,
        };
        Self::new(kind, message).into()
    }
}

impl fmt::Display for SttError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SttError {}

/// The error code a failed session raises: its [`SttErrorKind`]'s when the
/// adapter structured it, else [`classify_message`] over its text.
pub fn session_error_code(err: &anyhow::Error, hosted: bool) -> &'static str {
    match err.downcast_ref::<SttError>() {
        Some(e) => e.kind.code(hosted),
        None => classify_message(&err.to_string(), hosted),
    }
}

/// The error code for a failure known only by its text. Hosted mode routinely
/// hits 402 (out of credits) / 401 (expired cloud session); BYOK fails on a
/// rejected vendor key (401/403/"unauthorized"/"api key"); everything else is
/// "connect": the network or the provider, which a meeting retries.
pub fn classify_message(msg: &str, hosted: bool) -> &'static str {
    let low = msg.to_lowercase();
    let bad_key = msg.contains("401")
        || msg.contains("403")
        || low.contains("unauthorized")
        || low.contains("api key");
    // On-device failures (model missing, out of memory, unloadable) are
    // final: a redial would fail the same way. "local-missing",
    // "local-memory" or "local" (see local_stt::failure_code).
    if low.starts_with("local transcription") {
        crate::local_stt::failure_code(msg)
    } else if hosted && msg.contains("402") {
        "quota"
    } else if hosted && msg.contains("401") {
        "auth"
    } else if !hosted && bad_key {
        "key"
    } else {
        "connect"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every failure text the adapters and the hosted relay produce today,
    /// with the code it must keep raising in BYOK and in hosted mode.
    #[test]
    fn failure_messages_keep_their_codes() {
        let cases: &[(&str, &str, &str)] = &[
            // (message, BYOK code, hosted code)
            ("connect failed: HTTP 401", "key", "auth"),
            ("connect failed: HTTP 402", "connect", "quota"),
            ("connect failed: HTTP 403", "key", "connect"),
            ("connect failed: HTTP 429", "connect", "connect"),
            ("connect failed: HTTP 500", "connect", "connect"),
            ("connect failed: HTTP error: 401 Unauthorized", "key", "auth"),
            (
                "connect failed: IO error: connection refused",
                "connect",
                "connect",
            ),
            ("connect timed out", "connect", "connect"),
            ("server error 401: Invalid API key", "key", "auth"),
            ("server error 400: bad audio", "connect", "connect"),
            ("server error: Unauthorized connection", "key", "connect"),
            ("closed by server: 1008 API key not valid", "key", "connect"),
            ("closed by server: 1011 NET-0001", "connect", "connect"),
            ("Incorrect API key provided", "key", "connect"),
            ("soniox stream ended mid-session", "connect", "connect"),
            (
                "deepgram stream died mid-session (send failed)",
                "connect",
                "connect",
            ),
            (
                "hosted transcription quota exceeded (402): Monthly quota used up",
                "connect",
                "quota",
            ),
            (
                "hosted transcription rejected the session (400): bad",
                "connect",
                "connect",
            ),
            (
                "hosted transcription idle timeout (408): idle",
                "connect",
                "connect",
            ),
            (
                "hosted transcription service unavailable: x",
                "connect",
                "connect",
            ),
            (
                "hosted transcription closed by server (4999): x",
                "connect",
                "connect",
            ),
            (
                "hosted transcription requires the cloud endpoint",
                "connect",
                "connect",
            ),
            (
                "Local transcription model 'm' is not downloaded. Download it in Settings › Transcription.",
                "local-missing",
                "local-missing",
            ),
            (
                "Local transcription: not enough memory to load model 'm'. Choose a smaller model in Settings › Transcription.",
                "local-memory",
                "local-memory",
            ),
            ("Local transcription model 'm' is unknown.", "local", "local"),
            (
                "Local transcription model 'm' failed to load: init failed 401",
                "local",
                "local",
            ),
        ];
        for (msg, byok, hosted) in cases {
            assert_eq!(classify_message(msg, false), *byok, "BYOK: {msg}");
            assert_eq!(classify_message(msg, true), *hosted, "hosted: {msg}");
            // An unstructured error classifies by its text.
            let plain = anyhow::anyhow!(msg.to_string());
            assert_eq!(session_error_code(&plain, false), *byok, "BYOK: {msg}");
            assert_eq!(session_error_code(&plain, true), *hosted, "hosted: {msg}");
        }
    }

    /// A refused upgrade raises exactly the code its text always did, for every
    /// status, in both message shapes the adapters use.
    #[test]
    fn a_status_error_keeps_the_code_its_text_had() {
        for status in 100u16..600 {
            let reason = reqwest::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or("");
            for message in [
                format!("connect failed: HTTP {status}"),
                format!("connect failed: HTTP error: {status} {reason}"),
            ] {
                let err = SttError::from_status(status, message.clone());
                assert_eq!(err.to_string(), message);
                for hosted in [false, true] {
                    assert_eq!(
                        session_error_code(&err, hosted),
                        classify_message(&message, hosted),
                        "{message} hosted={hosted}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_local_error_keeps_its_text_and_code() {
        let messages = [
            crate::local_stt::not_downloaded_error("m"),
            crate::local_stt::not_enough_memory_error("m"),
            "Local transcription model 'm' is unknown.".to_string(),
            "Local transcription model path is not valid UTF-8".to_string(),
            "Local transcription model 'm' failed to load: init failed".to_string(),
            "resolve app data dir: no home".to_string(),
        ];
        for message in messages {
            let err = SttError::local(message.clone());
            assert_eq!(err.to_string(), message);
            for hosted in [false, true] {
                assert_eq!(
                    session_error_code(&err, hosted),
                    classify_message(&message, hosted),
                    "{message}"
                );
            }
        }
        let missing = SttError::local(crate::local_stt::not_downloaded_error("m"));
        assert_eq!(
            missing.downcast_ref::<SttError>().map(|e| e.kind),
            Some(SttErrorKind::ModelMissing)
        );
        let plain = SttError::local("resolve app data dir: no home".to_string());
        assert!(plain.downcast_ref::<SttError>().is_none());
    }

    #[test]
    fn kinds_map_onto_the_codes_the_frontend_knows() {
        use SttErrorKind::*;
        let table = [
            (Unauthorized, "key", "auth"),
            (Forbidden, "key", "connect"),
            (QuotaExceeded, "connect", "quota"),
            (ModelMissing, "local-missing", "local-missing"),
            (OutOfMemory, "local-memory", "local-memory"),
            (Local, "local", "local"),
        ];
        for (kind, byok, hosted) in table {
            assert_eq!(kind.code(false), byok, "{kind:?}");
            assert_eq!(kind.code(true), hosted, "{kind:?}");
        }
    }
}
