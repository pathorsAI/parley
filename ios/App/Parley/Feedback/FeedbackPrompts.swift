import ParleyKit
import SwiftUI

/// Whether an on-screen prompt was used — sent, or answered with the other
/// action it offered — or closed.
///
/// A reference, held in `@State`, so it survives the re-renders in which the
/// prompt's own parent stops drawing it: the send that takes a prompt off
/// screen must not be counted, a moment later, as the prompt disappearing
/// unused.
@MainActor
final class FeedbackPromptTicket {
    fileprivate(set) var resolved = false
}

extension View {
    /// The frequency-limit bookkeeping every inline prompt shares: on screen
    /// means offered (this recording will not be asked about for this reason
    /// again), and leaving the screen unused — navigating away, scrolling it
    /// out of a lazy list — counts as a dismissal, once.
    @MainActor
    func feedbackPrompt(
        _ trigger: FeedbackTrigger, recordingId: String?, ticket: FeedbackPromptTicket
    ) -> some View {
        onAppear {
            FeedbackCenter.shared.noteOffered(trigger, recordingId: recordingId)
        }
        .onDisappear {
            guard !ticket.resolved else { return }
            ticket.resolved = true
            FeedbackCenter.shared.noteDismissed(trigger)
        }
    }
}

extension FeedbackPromptTicket {
    /// The user acted on the prompt; whatever happens to it next is not a
    /// dismissal.
    func markUsed() { resolved = true }

    /// The user closed it with ✕. Counted here, once, rather than by the
    /// `onDisappear` that follows.
    func markClosed(_ trigger: FeedbackTrigger) {
        guard !resolved else { return }
        resolved = true
        FeedbackCenter.shared.noteDismissed(trigger)
    }
}

/// The shape every inline prompt has: a sentence, 「傳診斷給我們」, sometimes a
/// second action, and a way to close it.
///
/// No fill. The app's reading screens carry no tinted cards (see
/// `FilingSuggestionCard`), and a prompt that is about a failure should not be
/// louder than the failure's own explanation — a hairline frame is enough to
/// say "this is a separate thing from the transcript".
struct FeedbackPromptCard: View {
    let trigger: FeedbackTrigger
    let recordingId: String?
    let text: Text
    var secondary: (label: LocalizedStringKey, action: () -> Void)?
    /// Called after the ticket is settled; the parent stops drawing the card
    /// and sends.
    let send: () -> Void
    /// Called after the ticket is settled; the parent stops drawing the card.
    let close: () -> Void

    @State private var ticket = FeedbackPromptTicket()

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 8) {
                text
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.label))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 18) {
                    Button("Send diagnostics") {
                        ticket.markUsed()
                        send()
                    }
                    .font(.parley.footnote.weight(.semibold))
                    if let secondary {
                        Button(secondary.label) {
                            ticket.markUsed()
                            secondary.action()
                        }
                        .font(.parley.footnote)
                    }
                }
                .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
            Button {
                ticket.markClosed(trigger)
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.parley.caption.weight(.semibold))
                    .foregroundStyle(Color(.tertiaryLabel))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.leading, 12)
        .padding(.vertical, 10)
        .padding(.trailing, 4)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(.separator), lineWidth: 0.5))
        .feedbackPrompt(trigger, recordingId: recordingId, ticket: ticket)
    }
}

/// The transcript face of a recording of 20 s or more with nothing in it
/// (`empty_transcript`). Replaces the one-line "This recording has no
/// transcript." for exactly those recordings, because "no transcript" on a
/// 24-minute meeting is not a state, it is a failure, and it should read as
/// one.
///
/// The explanation is always shown; only 「傳診斷給我們」 is subject to the
/// frequency limits — a recording that has already been asked about still
/// deserves an honest empty state, and still offers Re-transcribe.
struct EmptyTranscriptState: View {
    let recordingId: String
    let durationMs: Double
    /// Whether this visit may offer the report. Decided once by the parent
    /// when the recording loaded, not re-read per render.
    let offersReport: Bool
    let reTranscribe: (() -> Void)?
    let send: () -> Void

    @State private var ticket = FeedbackPromptTicket()
    @State private var sent = false

    private var minutes: Int { max(1, Int((durationMs / 60_000).rounded())) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No text came out of this recording")
                .font(.parley.headline)
            Text("Recorded \(minutes) minutes, but the transcript is empty.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 20) {
                if offersReport && !sent {
                    Button("Send diagnostics") {
                        ticket.markUsed()
                        sent = true
                        send()
                    }
                    .font(.parley.subheadlineEmphasized)
                    .feedbackPrompt(.emptyTranscript, recordingId: recordingId, ticket: ticket)
                }
                if let reTranscribe {
                    Button("Re-transcribe") {
                        ticket.markUsed()
                        reTranscribe()
                    }
                    .font(.parley.subheadline)
                }
            }
            .buttonStyle(.borderless)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

/// 「上一次哪裡不好？」 after a re-transcription finished (`retranscribe`). One
/// tap on a chip is the whole report — the chip's id is the tag.
struct RetranscribeChips: View {
    let recordingId: String
    let send: (RetranscribeTag) -> Void
    let close: () -> Void

    @State private var ticket = FeedbackPromptTicket()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("What was wrong with the last one?")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                Spacer(minLength: 0)
                Button {
                    ticket.markClosed(.retranscribe)
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.parley.caption.weight(.semibold))
                        .foregroundStyle(Color(.tertiaryLabel))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(RetranscribeTag.allCases) { tag in
                        Button {
                            ticket.markUsed()
                            send(tag)
                        } label: {
                            Text(Self.label(tag))
                                .font(.parley.footnote)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .overlay(Capsule().stroke(Color(.separator), lineWidth: 0.5))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(.label))
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .feedbackPrompt(.retranscribe, recordingId: recordingId, ticket: ticket)
    }

    static func label(_ tag: RetranscribeTag) -> LocalizedStringKey {
        switch tag {
        case .misheard: return "Misheard words"
        case .missing: return "Missing parts"
        case .speakers: return "Wrong speakers"
        case .other: return "Something else"
        }
    }
}
