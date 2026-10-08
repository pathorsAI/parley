import ParleyKit
import SwiftUI

/// "Fix this word": a correction the user states outright — what dictation
/// heard, and what it should have been.
///
/// The keyboard can only learn from a fix made while it is still up in the same
/// field (`KeyboardLexiconWatch`). A word fixed with the Apple keyboard, after
/// the message was sent, or in another app entirely is invisible to it — and
/// those are most fixes. This sheet is the way to teach Parley one of those: it
/// opens from a dictation in the history with the selected words already in
/// "Heard as", and from the personal dictionary empty.
///
/// What Save does is the caller's (the history also rewrites the entry); what
/// it may save is decided here, by `Lexicon.problem`, so the button is never
/// enabled for a pair the dictionary would refuse. A pair saved here is stored
/// already confirmed (`LexiconStore.recordConfirmed`): the two-sightings rule
/// exists to tell a mishearing from a change of mind, and nobody fills in a
/// form by changing their mind.
struct LexiconCorrectionSheet: View {
    let save: (_ original: String, _ replacement: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var original: String
    @State private var replacement = ""
    @FocusState private var focus: Field?

    private enum Field { case original, replacement }

    init(heard: String, save: @escaping (_ original: String, _ replacement: String) -> Void) {
        self.save = save
        _original = State(initialValue: heard.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var trimmedOriginal: String {
        original.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedReplacement: String {
        replacement.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var problem: Lexicon.PairProblem? {
        Lexicon.problem(original: trimmedOriginal, replacement: trimmedReplacement)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(), text: $original)
                        .accessibilityLabel(Text("Heard as"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .original)
                        .submitLabel(.next)
                        .onSubmit { focus = .replacement }
                } header: {
                    SettingsSection.header("Heard as")
                }
                Section {
                    TextField(String(), text: $replacement)
                        .accessibilityLabel(Text("Should be"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .replacement)
                        .submitLabel(.done)
                        .onSubmit(commit)
                } header: {
                    SettingsSection.header("Should be")
                } footer: {
                    footer
                }
            }
            .font(.parley.body)
            .navigationTitle("Fix this word")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: commit)
                        .font(.parley.bodyEmphasized)
                        .disabled(problem != nil)
                }
            }
            // Straight to the empty field: with "Heard as" prefilled from the
            // selection, what is left to type is the right word.
            .onAppear { focus = trimmedOriginal.isEmpty ? .original : .replacement }
        }
        .presentationDetents([.medium, .large])
    }

    /// Why Save is off, when the reason is not obvious from two empty boxes —
    /// and otherwise what saving will do.
    @ViewBuilder private var footer: some View {
        switch problem {
        case .singleCharacter:
            SettingsSection.footer("Use at least two characters, so one character isn't changed everywhere it appears.")
        case .grows:
            SettingsSection.footer("The correction can't contain what was heard, or it would keep growing every time it's applied.")
        default:
            SettingsSection.footer("Parley changes it to this from your next dictation, and listens for it when you speak.")
        }
    }

    private func commit() {
        guard problem == nil else { return }
        save(trimmedOriginal, trimmedReplacement)
        dismiss()
    }
}

/// A correction about to be made, as `.sheet(item:)` wants it: what to
/// prefill, and which history entry it came from, if any.
struct LexiconCorrectionDraft: Identifiable {
    let id = UUID()
    var heard: String
    var entryID: UUID?
}
