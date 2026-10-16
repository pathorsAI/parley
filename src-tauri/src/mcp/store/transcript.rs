//! A saved recording's transcript as text an analyst reads: timestamped,
//! speaker-labelled lines, on the same (possibly estimated) clock the app shows.

use serde_json::Value;

// ── Untimed transcripts (#576) ────────────────────────────────────────────────
//
// Phone batch transcriptions before #576 synced with every line stamped 0 → 0.
// The app shows those with an ESTIMATED clock (src/lib/replay/timing.ts); the
// transcript handed to an external analyst has to read the same clock, or a
// finding it anchors at [m:ss] lands on a different line in the app. This is a
// port of `hasMissingTiming` + `estimateMissingTiming` + `estimateSpeechMs` —
// keep them in step; `estimated_starts_match_the_frontend` pins the numbers
// timing.test.ts pins.

/// Per-character speaking time, as in importTranscript.ts.
const CJK_MS_PER_CHAR: f64 = 270.0;
const LATIN_MS_PER_WORD: f64 = 380.0;
const MIN_SEGMENT_MS: f64 = 1000.0;

/// The kana + CJK ranges importTranscript.ts's `CJK_RE` matches.
fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{30FF}' | '\u{3400}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}')
}

/// How long a line takes to say (`estimateSpeechMs`).
fn estimate_speech_ms(text: &str) -> f64 {
    let cjk = text.chars().filter(|c| is_cjk(*c)).count() as f64;
    let latin_words = text
        .split(|c: char| is_cjk(c) || c.is_whitespace() || c == '\u{FEFF}')
        .filter(|w| w.chars().any(|c| c.is_ascii_alphanumeric()))
        .count() as f64;
    (cjk * CJK_MS_PER_CHAR + latin_words * LATIN_MS_PER_WORD).max(MIN_SEGMENT_MS)
}

fn seg_text(s: &Value) -> &str {
    s.get("text").and_then(Value::as_str).unwrap_or("")
}

/// `Math.round` for the non-negative values this deals in.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// When `segments` carry no timing at all (two or more spoken lines, every one
/// 0 → 0), the estimated start of EVERY segment, index-aligned with the array;
/// `None` for a transcript with real timing.
pub(super) fn estimated_starts(meta: &Value, segments: &[Value]) -> Option<Vec<i64>> {
    let mut spoken = 0;
    for s in segments {
        if seg_text(s).trim().is_empty() {
            continue;
        }
        let zero = |k: &str| s.get(k).and_then(Value::as_f64) == Some(0.0);
        if !zero("startMs") || !zero("endMs") {
            return None;
        }
        spoken += 1;
    }
    if spoken < 2 {
        return None;
    }
    let weights: Vec<f64> = segments
        .iter()
        .map(|s| {
            let text = seg_text(s);
            if text.trim().is_empty() {
                0.0
            } else {
                estimate_speech_ms(text)
            }
        })
        .collect();
    let total: f64 = weights.iter().sum();
    let duration = meta
        .get("durationMs")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let scale = if total > 0.0 && duration.is_finite() && duration > 0.0 {
        duration / total
    } else {
        1.0
    };
    let mut cursor = 0.0;
    Some(
        weights
            .iter()
            .map(|w| {
                let start = js_round(cursor * scale);
                cursor += w;
                start
            })
            .collect(),
    )
}

/// Rebuild the saved transcript as "[m:ss] [Speaker] text" lines — the same
/// labelling the frontend's transcriptAsText/speakerLabel produce (store.ts).
pub(super) fn transcript_text(meta: &Value, names: &Value) -> String {
    let Some(segments) = meta.get("segments").and_then(Value::as_array) else {
        return String::new();
    };
    let estimated = estimated_starts(meta, segments);
    let start_of = |i: usize, s: &Value| match &estimated {
        Some(starts) => starts[i],
        None => s.get("startMs").and_then(Value::as_i64).unwrap_or(0),
    };
    let mut finals: Vec<(i64, &Value)> = segments
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            s.get("isFinal").and_then(Value::as_bool).unwrap_or(false)
                && !seg_text(s).trim().is_empty()
        })
        .map(|(i, s)| (start_of(i, s), s))
        .collect();
    finals.sort_by_key(|(start, _)| *start);
    let note = if estimated.is_some() {
        "(This transcript synced without timestamps; the times below are estimated from the recording's length.)\n"
    } else {
        ""
    };
    let lines = finals
        .iter()
        .map(|(start, s)| {
            let start = (*start).max(0);
            let total = start / 1000;
            let source = s.get("source").and_then(Value::as_str).unwrap_or("me");
            let speaker = s.get("speaker").and_then(Value::as_i64).unwrap_or(0);
            let label = speaker_label(names, source, speaker);
            let text = s.get("text").and_then(Value::as_str).unwrap_or("").trim();
            format!("[{}:{:02}] [{label}] {text}", total / 60, total % 60)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{note}{lines}")
}

/// One segment's speaker label: the user's own name for that voice when there is
/// one, otherwise the same default the frontend's speakerLabel derives (store.ts).
fn speaker_label(names: &Value, source: &str, speaker: i64) -> String {
    let key = format!("{source}-{speaker}");
    if let Some(custom) = names.get(&key).and_then(Value::as_str) {
        return custom.to_string();
    }
    let display = if speaker == 0 { 1 } else { speaker };
    match source {
        "mix" => format!("Speaker {display}"),
        "me" if display <= 1 => "You".to_string(),
        "me" => format!("Speaker {display}"),
        _ if speaker > 0 => format!("Remote {speaker}"),
        _ => "Them".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tests::untimed_meta;
    use serde_json::json;

    #[test]
    fn estimated_starts_match_the_frontend() {
        // Same fixture + numbers as timing.test.ts ("matches the cross-language
        // fixture") — a drift here moves MCP-anchored findings off their lines.
        let meta = untimed_meta(
            &[
                "你好，今天我們討論報價。",
                "OK, let's go over the price.",
                "好",
                "Sounds good 那就這樣",
            ],
            95_000.0,
        );
        let segs = meta["segments"].as_array().unwrap();
        assert_eq!(
            estimated_starts(&meta, segs),
            Some(vec![0, 32_801, 60_499, 72_647])
        );
    }

    #[test]
    fn estimated_starts_leave_a_timed_transcript_alone() {
        let meta = json!({ "durationMs": 5000, "segments": [
            { "text": "first", "startMs": 0, "endMs": 1200 },
            { "text": "second", "startMs": 1300, "endMs": 2000 },
        ]});
        let segs = meta["segments"].as_array().unwrap();
        assert_eq!(estimated_starts(&meta, segs), None);
        // One spoken line at 0 is not evidence of missing timing.
        let one = untimed_meta(&["only"], 5000.0);
        assert_eq!(
            estimated_starts(&one, one["segments"].as_array().unwrap()),
            None
        );
    }

    #[test]
    fn timed_transcript_reads_unchanged() {
        let meta = json!({ "durationMs": 5000, "segments": [
            { "source": "mix", "speaker": 1, "text": "first", "isFinal": true, "startMs": 0, "endMs": 1200 },
            { "source": "mix", "speaker": 2, "text": "second", "isFinal": true, "startMs": 61_000, "endMs": 62_000 },
        ]});
        let text = transcript_text(&meta, &json!({}));
        assert_eq!(text, "[0:00] [Speaker 1] first\n[1:01] [Speaker 2] second");
    }
}
