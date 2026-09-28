import Foundation

/// Whether a finished dictation went out AI-polished, and when it did not, why.
///
/// The polish is best-effort by design (`TranscriptPolisher`): every way it can
/// go wrong resolves to "insert the raw words", silently, because none of them
/// is news worth interrupting someone's typing for. That silence had a cost.
/// "Sometimes the text looks unpolished, or I can't tell whether it was" was a
/// report nobody could answer — the history kept only the final text, so the
/// owner could not tell a polish that ran and changed little from one that
/// never ran, and neither could we. This is the answer, recorded per entry
/// (`DictationHistoryEntry.polish`) and logged per session.
///
/// **The raw values are stored** in the on-device history file, so they are a
/// wire format: never rename one, and never reuse a retired one for a different
/// meaning. A value this build does not know — a case a later build added,
/// read back after a downgrade — decodes as "no outcome recorded" rather than
/// as a broken entry (see `DictationHistoryEntry.init(from:)`): the history
/// treats an undecodable file as empty, and losing every dictation over one
/// unfamiliar label would be a strange trade.
public enum PolishOutcome: String, Codable, Sendable, CaseIterable {
    /// The rewrite came back, passed `TranscriptPolisher.verdict`, and is what
    /// was inserted.
    case polished

    // MARK: never sent

    /// Under `TranscriptPolisher.minimumCharacters`: a phrase that short has
    /// nothing to tidy, and the round trip is not worth it.
    case tooShort
    /// The "Polish with AI" switch is off, or there was no account token to
    /// send it with — the polish was never going to run for a reason other
    /// than the text.
    case off
    /// The user tapped "insert without polishing" on the keyboard.
    case skipped

    // MARK: sent, and it did not come back usable

    /// The reply did not arrive within the coordinator's polish budget.
    case timedOut
    /// The reply introduced Simplified Chinese into a transcript that had none
    /// (`TranscriptPolisher.containsSimplifiedChinese`).
    case rejectedScript
    /// The reply's length was outside the band a rewrite stays inside — the
    /// shape of an answer, a summary, a translation or a truncation.
    case rejectedLength
    /// Transport, HTTP or decoding failure, or anything else that threw.
    case failed
    /// The session was still finishing at its safety-net deadline
    /// (`FinishingPolish.deadlinePassed`) and settled raw without waiting any
    /// longer for the drain or the polish.
    case overdue

    /// Whether the inserted text is the model's rewrite.
    public var isPolished: Bool { self == .polished }
}
