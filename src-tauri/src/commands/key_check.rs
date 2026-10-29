//! Onboarding's check that a pasted speech-to-text key is one the vendor
//! accepts, before the wizard moves on: one cheap authenticated read (a list
//! of models, projects or transcripts), made from Rust so the webview's CORS
//! rules don't get in the way. Only a clear refusal counts against the key;
//! being offline, a timeout or an odd status is "can't tell", and the wizard
//! lets the user through rather than blocking them on our check.

use std::time::Duration;

use serde::Serialize;

/// How long to wait for the vendor before calling it "can't tell".
const TIMEOUT: Duration = Duration::from_secs(10);

/// What the vendor said about the key.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KeyCheck {
    /// The vendor answered and accepted it.
    Accepted,
    /// The vendor refused it.
    Rejected,
    /// We couldn't tell (offline, timeout, an unexpected answer).
    Unknown,
}

#[tauri::command]
pub async fn verify_stt_key(provider: String, key: String) -> KeyCheck {
    let key = key.trim();
    if key.is_empty() {
        return KeyCheck::Rejected;
    }
    let Ok(client) = reqwest::Client::builder().timeout(TIMEOUT).build() else {
        return KeyCheck::Unknown;
    };
    let request = match provider.as_str() {
        "soniox" => client
            .get("https://api.soniox.com/v1/models")
            .bearer_auth(key),
        "deepgram" => client
            .get("https://api.deepgram.com/v1/projects")
            .header("Authorization", format!("Token {key}")),
        "assemblyai" => client
            .get("https://api.assemblyai.com/v2/transcript?limit=1")
            .header("Authorization", key),
        "openai" => client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(key),
        "gemini" => client
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .header("x-goog-api-key", key),
        // Hosted and on-device providers have no key to check.
        _ => return KeyCheck::Unknown,
    };
    match request.send().await {
        Ok(response) => classify(&provider, response.status().as_u16()),
        Err(error) => {
            log::warn!("key check: {provider} unreachable: {error}");
            KeyCheck::Unknown
        }
    }
}

/// Read the vendor's status as a verdict on the key.
fn classify(provider: &str, status: u16) -> KeyCheck {
    match status {
        200..=299 => KeyCheck::Accepted,
        401 => KeyCheck::Rejected,
        // A Deepgram key limited to transcription may not list projects, so
        // a 403 there says nothing about the key.
        403 if provider == "deepgram" => KeyCheck::Unknown,
        403 => KeyCheck::Rejected,
        // Gemini answers a malformed or unknown key with 400 API_KEY_INVALID.
        400 if provider == "gemini" => KeyCheck::Rejected,
        _ => KeyCheck::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_accepts_and_unauthorised_rejects() {
        assert_eq!(classify("soniox", 200), KeyCheck::Accepted);
        assert_eq!(classify("assemblyai", 401), KeyCheck::Rejected);
        assert_eq!(classify("openai", 403), KeyCheck::Rejected);
    }

    #[test]
    fn a_deepgram_403_is_not_held_against_the_key() {
        assert_eq!(classify("deepgram", 403), KeyCheck::Unknown);
        assert_eq!(classify("deepgram", 401), KeyCheck::Rejected);
    }

    #[test]
    fn gemini_reports_a_bad_key_as_400() {
        assert_eq!(classify("gemini", 400), KeyCheck::Rejected);
        assert_eq!(classify("openai", 400), KeyCheck::Unknown);
    }

    #[test]
    fn rate_limits_and_outages_cannot_tell() {
        assert_eq!(classify("soniox", 429), KeyCheck::Unknown);
        assert_eq!(classify("deepgram", 503), KeyCheck::Unknown);
    }
}
