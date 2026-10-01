import ParleyKit
import SwiftUI
import UIKit

/// Getting transcript text off the phone and into somewhere else.
///
/// Both transcript screens show the same three facts — who spoke, when, and
/// what they said — so they share one plain-text shape instead of each
/// inventing its own. A transcript pasted into a mail draft should read the
/// same whether it was copied mid-meeting or from a recording opened a week
/// later:
///
///     Speaker A  0:12
///     Let's start with the renewal.
///
///     Speaker B  0:19
///     Sure — the term is the part we want to revisit.
///
/// The screens disagree on only one thing, how a speaker is named: the live
/// screen has nothing but diarization indices, while a synced recording may
/// carry names the desktop app assigned. So the caller supplies the label.
enum TranscriptClipboard {
    /// The live screen's naming rule, kept here so the copied text can't drift
    /// from what `SegmentRow` renders. Speakers are letters — 「講者 A」/
    /// "Speaker A", see `speakerLetter` — and index 0 means the provider hasn't
    /// decided who is talking yet, where an ellipsis admits it rather than
    /// naming someone.
    ///
    /// `Speaker %@` is deliberately the same key ParleyKit's catalog uses for
    /// `RecordingMeta.speakerLabel`, so the live screen and a recording opened
    /// later can never name the same speaker two different ways. It is a format
    /// string filled in afterwards rather than an interpolated key: the latter
    /// would be a separate, untranslatable key per speaker index.
    static func liveLabel(for segment: TranscriptSegment) -> String {
        let letter = speakerLetter(segment.speaker)
        guard !letter.isEmpty else { return "…" }
        return String(format: String(localized: "Speaker %@"), letter)
    }

    /// Elapsed time as m:ss, matching the timestamps on screen.
    static func clock(_ ms: UInt64) -> String {
        let s = ms / 1000
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    static func plainText(_ segment: TranscriptSegment, label: String) -> String {
        "\(label)  \(clock(segment.startMs))\n\(segment.text)"
    }

    /// Segments are separated by a blank line so that speaker turns survive
    /// being pasted into an editor that reflows paragraphs.
    static func plainText(
        _ segments: [TranscriptSegment], label: (TranscriptSegment) -> String
    ) -> String {
        segments.map { plainText($0, label: label($0)) }.joined(separator: "\n\n")
    }

    static func write(_ text: String) {
        UIPasteboard.general.string = text
    }
}

/// The toolbar copy button for a whole transcript.
///
/// The app has no toast layer and this is not the place to grow one, so the
/// confirmation is the button itself: the icon becomes a checkmark for a
/// moment. Without it a tap on a "copy everything" button gives no evidence it
/// did anything, and people tap again. The same swap is announced to VoiceOver
/// through the accessibility label, which is the only signal a checkmark glyph
/// carries for someone who can't see it.
struct CopyTranscriptButton: View {
    /// Evaluated on tap rather than on every redraw — during a live meeting the
    /// transcript changes several times a second.
    let text: () -> String
    /// Nothing to copy: the button stays visible so the toolbar doesn't shuffle
    /// when the first segment lands, but it can't be pressed.
    let isEmpty: Bool

    @State private var copied = false
    @State private var revert: Task<Void, Never>?

    var body: some View {
        Button {
            let payload = text()
            guard !payload.isEmpty else { return }
            TranscriptClipboard.write(payload)
            withAnimation { copied = true }
            // A second tap restarts the window instead of being cut short by
            // the first tap's pending revert.
            revert?.cancel()
            revert = Task {
                try? await Task.sleep(for: .seconds(1.5))
                guard !Task.isCancelled else { return }
                withAnimation { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .contentTransition(.symbolEffect(.replace))
        }
        .disabled(isEmpty)
        .accessibilityLabel(copied ? Text("Copied") : Text("Copy transcript"))
    }
}

/// The recording screen's share-and-copy menu: the hand-off to the user's own
/// AI first, the plain copy below a divider.
///
/// Replaces `CopyTranscriptButton` on the recording screen only. The live
/// screen keeps the single button — mid-meeting the reason to copy is the line
/// that was just said, and there is nothing yet to analyse.
///
/// Same confirmation as the button: the glyph turns into a checkmark for a
/// moment after either copy, since the app has no toast layer. The share
/// sheet is its own confirmation.
struct TranscriptShareMenu: View {
    /// The transcript alone. Evaluated on tap.
    let plain: () -> String
    /// The analysis prompt plus the transcript — `HandoffPrompt`.
    let withPrompt: () -> String
    let isEmpty: Bool
    /// Present the share sheet. The screen owns it, because the checklist can
    /// ask for it too (`RecordingDetailView.presentsShareOnLoad`).
    let share: () -> Void

    @State private var copied = false
    @State private var revert: Task<Void, Never>?

    var body: some View {
        Menu {
            Button {
                share()
            } label: {
                Label("Share to AI (with analysis prompt)", systemImage: "square.and.arrow.up")
            }
            Button {
                if copy(withPrompt()) { GettingStartedStore.shared.mark(.sharedToAI) }
            } label: {
                Label("Copy with analysis prompt", systemImage: "doc.on.clipboard")
            }
            Divider()
            Button {
                copy(plain())
            } label: {
                Label("Copy transcript", systemImage: "doc.on.doc")
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "square.and.arrow.up")
                .contentTransition(.symbolEffect(.replace))
        }
        .disabled(isEmpty)
        .accessibilityLabel(copied ? Text("Copied") : Text("Share or copy transcript"))
    }

    @discardableResult
    private func copy(_ payload: String) -> Bool {
        guard !payload.isEmpty else { return false }
        TranscriptClipboard.write(payload)
        withAnimation { copied = true }
        revert?.cancel()
        revert = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            withAnimation { copied = false }
        }
        return true
    }
}

/// `UIActivityViewController`, for a SwiftUI `.sheet`.
///
/// `ShareLink` would be less code and cannot do the one thing needed here: say
/// whether the user actually sent the text somewhere, which is what ticks the
/// checklist's hand-off item. `completed` is false for a cancel.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onFinish: (_ completed: Bool) -> Void = { _ in }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, _ in
            onFinish(completed)
        }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
