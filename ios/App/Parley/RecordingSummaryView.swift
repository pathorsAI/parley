import ParleyKit
import SwiftUI

/// The recording screen's summary face: what the meeting came to, apart from
/// what was said in it. See `docs/design/ios-recording-page.md`.
///
/// Top to bottom — brief, action items, highlights, speakers — which is the
/// order a person back from a meeting asks in: what happened, what do I have to
/// do, what should I look at again, who was there. Every timestamp on the face
/// is a way *into* the transcript rather than a label: it hands the moment to
/// `jump`, which switches faces, seeks, and lights the turn.
///
/// The same page as the transcript: white, no cards, sections separated by
/// whitespace with a small sentence-case label over each. Blue appears only on
/// what can be tapped — the timestamps and the one button of the empty state.
struct RecordingSummaryView: View {
    let meta: RecordingMeta
    /// The people in the transcript, in order of first appearance, as the
    /// transcript labels them.
    let speakers: [String]
    /// Whether a tick on an action item is kept. True for the sample, which
    /// keeps its ticks on the phone; a cloud recording shows the ticks it has
    /// and takes none, because the phone has no write path for them.
    let canTickActionItems: Bool
    /// Whether there is a transcript to hand to an AI, for the empty state.
    let canGenerate: Bool
    let jump: (UInt64) -> Void
    let tickActionItem: (String, Bool) -> Void
    let generate: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                if meta.hasAnalysis {
                    if !meta.brief.isEmpty { brief }
                    if !meta.actionItems.isEmpty { actionItems }
                    if !meta.findings.isEmpty { highlights }
                } else {
                    noSummary
                }
                if !speakers.isEmpty { speakerList }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        // A timestamp in the brief is a link inside running text; this is
        // where its tap lands. Anything that is not ours goes on to the system.
        .environment(
            \.openURL,
            OpenURLAction { url in
                guard let ms = Self.moment(from: url) else { return .systemAction }
                jump(ms)
                return .handled
            })
    }

    // MARK: brief

    private var brief: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(BriefMarkup.paragraphs(meta.brief).enumerated()), id: \.offset) { _, runs in
                Text(Self.attributed(runs))
                    .font(.parley.body)
                    .foregroundStyle(Color(.label))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    /// One paragraph as one `Text`, so it wraps as prose. Bold runs take the
    /// semibold face; a timestamp is a link whose URL carries the moment.
    static func attributed(_ runs: [BriefMarkup.Run]) -> AttributedString {
        var out = AttributedString()
        for run in runs {
            switch run {
            case .text(let text, let bold):
                var piece = AttributedString(text)
                if bold { piece.font = .parley.headline }
                out += piece
            case .timestamp(let ms, let label):
                var piece = AttributedString(label)
                piece.link = URL(string: "\(Self.scheme):\(ms)")
                piece.font = .parley.subheadline.monospacedDigit()
                out += piece
            }
        }
        return out
    }

    private static let scheme = "parley-moment"

    private static func moment(from url: URL) -> UInt64? {
        guard url.scheme == scheme else { return nil }
        return UInt64(url.absoluteString.dropFirst(scheme.count + 1))
    }

    // MARK: action items

    private var actionItems: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel(Text("Action items"))
            ForEach(meta.actionItems) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    check(item)
                    Text(verbatim: item.text)
                        .font(.parley.subheadline)
                        .foregroundStyle(item.done ? Color(.secondaryLabel) : Color(.label))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let atMs = item.atMs {
                        timestamp(atMs)
                    }
                }
            }
        }
    }

    /// The system green on a done item, as on the getting-started list: "this
    /// is done" in the platform's words. A button only where the tick is kept.
    @ViewBuilder
    private func check(_ item: RecordingMeta.ActionItem) -> some View {
        let mark = Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
            .font(.parley.body)
            .foregroundStyle(item.done ? Theme.success : Color(.tertiaryLabel))
        if canTickActionItems {
            Button {
                tickActionItem(item.id, !item.done)
            } label: {
                mark.frame(minWidth: 28, minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: item.text))
            .accessibilityValue(item.done ? Text("Done") : Text(verbatim: ""))
        } else {
            mark
                .accessibilityLabel(item.done ? Text("Done") : Text(verbatim: ""))
        }
    }

    // MARK: highlights

    /// The analysis's findings, each with the moment it came from.
    ///
    /// A 2pt rule down the left edge in `label`, and nothing else: no violet, no
    /// glyph, no fill. The rule says "this is a different kind of thing from
    /// the prose above" without claiming more importance than what was said.
    private var highlights: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionLabel(Text("Highlights \(meta.findings.count)"))
            ForEach(meta.findings) { finding in
                HStack(alignment: .top, spacing: 12) {
                    Rectangle()
                        .fill(Color(.label))
                        .frame(width: 2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: finding.title)
                                .font(.parley.subheadlineEmphasized)
                                .foregroundStyle(Color(.label))
                                .frame(maxWidth: .infinity, alignment: .leading)
                            timestamp(finding.atMs)
                        }
                        if !finding.detail.isEmpty {
                            Text(verbatim: finding.detail)
                                .font(.parley.footnote)
                                .foregroundStyle(Color(.secondaryLabel))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: speakers

    private var speakerList: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel(Text("Speakers"))
            ForEach(speakers, id: \.self) { name in
                Text(verbatim: name)
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.label))
            }
        }
    }

    // MARK: nothing to summarise

    /// Never a blank face: a recording with no analysis says so, and offers the
    /// way to get one — the same hand-off to the user's own AI the share menu
    /// makes, with the prompt and the transcript.
    private var noSummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("No summary yet.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
            Button(action: generate) {
                Label("Generate a summary with AI", systemImage: "square.and.arrow.up")
                    .font(.parley.subheadlineEmphasized)
            }
            .disabled(!canGenerate)
        }
    }

    // MARK: pieces

    private func sectionLabel(_ text: Text) -> some View {
        text
            .font(.parley.footnote.weight(.semibold))
            .foregroundStyle(Color(.secondaryLabel))
            .accessibilityAddTraits(.isHeader)
    }

    /// A moment, as a way into the transcript: the clock and an arrow, in the
    /// tint because it can be tapped.
    private func timestamp(_ ms: UInt64) -> some View {
        Button {
            jump(ms)
        } label: {
            HStack(spacing: 3) {
                Text(verbatim: TranscriptClipboard.clock(ms))
                    .monospacedDigit()
                Image(systemName: "arrow.right")
                    .font(.parley.caption2.weight(.semibold))
            }
            .font(.parley.caption)
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.primary)
        .accessibilityLabel(Text("Go to \(TranscriptClipboard.clock(ms)) in the transcript"))
    }
}
