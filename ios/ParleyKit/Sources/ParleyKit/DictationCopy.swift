import Foundation

/// What a tap on the voice keyboard's transcript slot copies, if anything.
///
/// The slot only ever shows the *tail* of a dictation — `tailLimit` characters
/// of it — and nothing else on the keyboard holds the rest once the session is
/// over. That was fine while every session ended in the field, but two endings
/// leave the user wanting the words somewhere else: a `done` whose text went
/// into the wrong field (or into a field that then threw it away), and an
/// `error` after the user had already said something. The keyboard never
/// inserts from an error — a failed session leaves the field as it was — so
/// there the words on screen were, until now, words the user had to say again.
/// Tapping the slot puts the whole of them on the pasteboard instead.
///
/// **Only once the session is over.** While it is `starting`, `listening`,
/// `reconnecting` or `finishing` the words are still moving, and the record
/// button owns the one tap that means something then (skip the polish). After
/// `cancelled` the pane has been cleared on purpose, and after `micTaken` the
/// notice has the slot and the session may yet resume — neither has words on
/// screen to copy.
///
/// **The whole transcript, never the tail.** `committed` is what the app
/// published: at `done` that is exactly the text the keyboard inserted — the
/// polished words, after the lexicon — and at `error` it is everything that had
/// settled before the failure. The echo above the button is capped for the
/// keyboard's memory's sake; the pasteboard is not, and a copy that quietly
/// dropped the first half of a long dictation would be worse than none.
///
/// **Full Access, or nothing.** Without it the keyboard cannot read the
/// downlink at all, so there would be nothing to copy anyway — but the rule is
/// written here rather than inferred, the way the haptics' guards are.
///
/// Pure, so the rules are tested here rather than trusted to the controller
/// that applies them. The result is held in memory by the keyboard for as long
/// as the slot shows it, and never written anywhere: the keyboard keeps no
/// typed content on disk (see `ios/AppStore/privacy-label.md`).
public enum DictationCopy {
    /// The text a tap on the slot should copy, or `nil` when the slot is not a
    /// copy target.
    public static func text(
        for state: DictationChannel.Downlink.State, committed: String, hasFullAccess: Bool
    ) -> String? {
        guard hasFullAccess else { return nil }
        switch state {
        case .done, .error:
            // Whitespace alone is not a dictation: an error before the first
            // word settled has nothing on screen to copy, and a copy target
            // with nothing behind it would put an empty string on the
            // pasteboard over whatever the user had there.
            let isEmpty = committed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            return isEmpty ? nil : committed
        case .starting, .listening, .reconnecting, .finishing, .cancelled, .micTaken:
            return nil
        }
    }
}
