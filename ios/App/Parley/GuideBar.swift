import ParleyKit
import SwiftUI

/// The guided lap, on the recording it is about: a slim bar pinned above the
/// tab bar that says what to do next on *this* screen — look at the
/// suggestion, replay a line, hand it to an AI — and says so again, briefly,
/// when it has been done.
///
/// Onboarding v1 only ticked a list on the Library; on the recording itself
/// nothing said what to do, and the owner's verdict was that it never felt like
/// onboarding. The bar is the missing half. It reads its step from the same
/// checklist (`GuidedLap`, ParleyKit), so the Library and the bar can never
/// disagree, and a step still ticks only from the real event.
///
/// Same chrome as the other pinned bars on this screen: page-coloured, a
/// hairline on the edge that faces the content, no card and no fill. Blue only
/// on what can be tapped; the ✓ is the system green, as on the checklist.
struct GuideBar: View {
    let display: GuidedLap.Display
    /// The questions the share will ask — the sample's own, or the generic three.
    let questions: [String]
    /// The folder the recording was just filed into, for the ✓ line, and
    /// whether the same accept renamed it.
    let filedFolder: String?
    let renamed: Bool
    /// Whether the recording has a suggestion card to point at. Without one,
    /// step 1's action opens the folder picker instead.
    let hasSuggestion: Bool

    let showSuggestion: () -> Void
    let openTranscript: () -> Void
    let share: () -> Void
    let copy: () -> Void
    let startMeeting: () -> Void
    let notNow: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(Theme.background)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
        }
        .animation(.easeOut(duration: 0.25), value: display)
    }

    @ViewBuilder
    private var content: some View {
        switch display {
        case .step(.file):
            step(
                Text("1 / 3 · See what Parley did for you"),
                body: Text(
                    "Every recording gets a name and a suggested folder when it's done. You can change the title or pick your own folder — tap Accept or any folder to try it."
                )
            ) {
                primary(hasSuggestion ? Text("Show me") : Text("Choose a folder"), showSuggestion)
            }
        case .confirmed(.file):
            confirmation(filedLine)
        case .step(.replay):
            step(
                Text("2 / 3 · Replay"),
                body: Text("Tap any line and the audio jumps to that moment. Try it.")
            ) {
                primary(Text("Open the transcript"), openTranscript)
            }
        case .confirmed(.replay):
            confirmation(Text("That's it. Search finds any word you remember."))
        case .step(.share):
            step(Text("3 / 3 · Hand it to your AI"), body: Text("Share it, paste it, and ask:")) {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(questions, id: \.self) { question in
                            Text(verbatim: "· \(question)")
                                .font(.parley.caption)
                                .foregroundStyle(Color(.secondaryLabel))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    HStack(spacing: 18) {
                        primary(Text("Share to AI"), share)
                        Button(action: copy) {
                            Text("Copy instead")
                                .font(.parley.footnote.weight(.semibold))
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        case .step(.done), .confirmed(.share), .confirmed(.done):
            done
        }
    }

    /// A step: its counter and name, the one sentence of why, its action, and
    /// the way out.
    private func step<Actions: View>(
        _ title: Text, body: Text, @ViewBuilder actions: () -> Actions
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                title
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Color(.label))
                Spacer(minLength: 8)
                Button(action: notNow) {
                    Label("Not now", systemImage: "xmark")
                        .font(.parley.caption)
                        .foregroundStyle(Color(.secondaryLabel))
                }
                .buttonStyle(.borderless)
            }
            body
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
            actions()
                .padding(.top, 2)
        }
    }

    private func confirmation(_ line: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Theme.success)
                .accessibilityHidden(true)
            line
                .font(.parley.subheadline)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var filedLine: Text {
        guard let filedFolder else { return Text("Filed. Every recording will get a suggestion like this.") }
        return renamed
            ? Text("Renamed and filed in “\(filedFolder)”. Every recording will do this from now on.")
            : Text("Filed in “\(filedFolder)”. Every recording will get a suggestion like this.")
    }

    // MARK: done

    private var done: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Theme.success)
                    .accessibilityHidden(true)
                Text("Done")
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Color(.label))
            }
            VStack(alignment: .leading, spacing: 2) {
                doneLine(Text("Named and filed"))
                doneLine(Text("Replayed"))
                doneLine(Text("Handed to your AI"))
            }
            Text(
                "That's a meeting in Parley: record → named and filed for you → replay → hand it to your AI. Next time it all happens on its own."
            )
            .font(.parley.footnote)
            .foregroundStyle(Color(.secondaryLabel))
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 18) {
                primary(Text("Start your first real meeting"), startMeeting)
                Button(action: close) {
                    Text("Close")
                        .font(.parley.footnote)
                        .foregroundStyle(Color(.secondaryLabel))
                }
                .buttonStyle(.borderless)
            }
            Text("On a Mac, Claude Code can also read your whole recording library directly over MCP.")
                .font(.parley.caption2)
                .foregroundStyle(Color(.tertiaryLabel))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func doneLine(_ text: Text) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark")
                .font(.parley.caption2.weight(.semibold))
                .foregroundStyle(Theme.success)
                .accessibilityHidden(true)
            text
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
        }
    }

    /// The step's one action: blue text, emphasized — the tint says it can be
    /// tapped, and nothing on this bar needs a filled button to be found.
    private func primary(_ label: Text, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label.font(.parley.subheadlineEmphasized)
        }
        .buttonStyle(.borderless)
    }
}
