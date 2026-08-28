import ParleyKit
import SwiftUI

/// The personal dictionary, made visible.
///
/// Everything on this screen was learned without being asked for, which is the
/// reason the screen exists at all: a feature that quietly rewrites what someone
/// dictates has to be a list they can read and a row they can delete. The
/// mechanism is `LexiconStore`; this is the only place a person edits it.
struct PersonalDictionaryView: View {
    /// Read once per appearance rather than observed. The keyboard writes this
    /// file from another process, and there is nothing to observe across that
    /// boundary — but nothing here is live either: a correction learned while
    /// this screen is open shows up the next time it is opened, which is soon
    /// enough for a list of words.
    @State private var lexicon = Lexicon()
    @State private var newTerm = ""
    @State private var showClearConfirmation = false

    var body: some View {
        Form {
            correctionsSection
            termsSection
            if !lexicon.pairs.isEmpty || !lexicon.terms.isEmpty {
                clearSection
            }
        }
        .font(.parley.body)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .environment(\.defaultMinListRowHeight, 48)
        .navigationTitle("Personal dictionary")
        .onAppear { lexicon = LexiconStore.load() }
        .confirmationDialog(
            "Clear your personal dictionary?", isPresented: $showClearConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear everything", role: .destructive) {
                LexiconStore.removeAll()
                lexicon = LexiconStore.load()
            }
        } message: {
            Text("Parley forgets every correction it has learned and every term you added. It starts learning again from your next dictation.")
        }
    }

    // MARK: learned corrections

    private var correctionsSection: some View {
        Section {
            if lexicon.pairs.isEmpty {
                Text("Nothing learned yet.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Theme.mutedForeground)
            } else {
                // Newest first, so a correction just learned sits where the
                // person who made it will look for it.
                ForEach(lexicon.pairsByRecency) { pair in
                    correctionRow(pair)
                }
                .onDelete(perform: deletePairs)
            }
        } header: {
            SettingsSection.header("Learned corrections")
        } footer: {
            SettingsSection.footer("When you fix a word straight after dictating it, Parley notices. It waits until it has seen the same fix twice before using it, so one change of mind doesn't become a rule. Swipe a row away to unlearn it.")
        }
        .listRowBackground(Theme.tintedSurface)
    }

    /// What was heard, an arrow, what the user meant — and how many times they
    /// have said so. The count is the honest thing to show: it is what decides
    /// whether the row is doing anything yet.
    private func correctionRow(_ pair: LexiconPair) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: pair.original)
                .foregroundStyle(Theme.mutedForeground)
            Image(systemName: "arrow.right")
                .font(.parley.caption)
                .foregroundStyle(Theme.mutedForeground)
            Text(verbatim: pair.replacement)
                .font(.parley.bodyEmphasized)
            Spacer(minLength: 8)
            if pair.count >= Lexicon.autoApplyThreshold {
                // Verbatim: a digit and a multiplication sign read the same in
                // both localizations, and a catalog key for them would be
                // noise.
                Text(verbatim: "\(pair.count)×")
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Theme.mutedForeground)
            } else {
                // Seen once, so it is not being applied. Saying "learning" is
                // the difference between a list of rules and a list of guesses.
                Text("Learning")
                    .font(.parley.caption)
                    .foregroundStyle(Theme.warning)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: preferred terms

    private var termsSection: some View {
        Section {
            HStack(spacing: 10) {
                TextField("Add a name or term", text: $newTerm)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(addTerm)
                Button("Add", action: addTerm)
                    .font(.parley.subheadlineEmphasized)
                    .disabled(newTerm.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            ForEach(lexicon.termsByRecency) { term in
                Text(verbatim: term.text)
            }
            .onDelete(perform: deleteTerms)
        } header: {
            SettingsSection.header("Your terms")
        } footer: {
            SettingsSection.footer("Names, jargon, and anything else you say often. Parley keeps them so it can prefer your spelling — this list is yours to keep even where transcription can't yet be biased toward it.")
        }
        .listRowBackground(Theme.tintedSurface)
    }

    private var clearSection: some View {
        Section {
            Button("Clear the dictionary", role: .destructive) {
                showClearConfirmation = true
            }
        }
        .listRowBackground(Theme.tintedSurface)
    }

    // MARK: editing

    private func addTerm() {
        let term = newTerm.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return }
        LexiconStore.addTerm(term)
        newTerm = ""
        lexicon = LexiconStore.load()
    }

    private func deletePairs(_ offsets: IndexSet) {
        let listed = lexicon.pairsByRecency
        for index in offsets {
            LexiconStore.removePair(original: listed[index].original)
        }
        lexicon = LexiconStore.load()
    }

    private func deleteTerms(_ offsets: IndexSet) {
        let listed = lexicon.termsByRecency
        for index in offsets {
            LexiconStore.removeTerm(listed[index].text)
        }
        lexicon = LexiconStore.load()
    }
}
