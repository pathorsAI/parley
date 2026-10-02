import ParleyKit
import SwiftUI

/// The personal dictionary, made visible.
///
/// Most of this screen was learned without being asked for, which is the
/// reason the screen exists at all: a feature that quietly rewrites what someone
/// dictates has to be a list they can read and a row they can delete. The
/// mechanism is `LexiconStore`; this is where a person edits it — adding a
/// correction outright ("Add correction", the same sheet as "Fix this word" in
/// the dictation history), a term, or taking either away.
///
/// The last section is the one thing here that is not the user's to edit: the
/// names and phrases the keyboard reads from Contacts and Text Replacement
/// (`Lexicon.systemTerms`). It is shown so nothing biasing recognition is
/// hidden, and read-only because it is replaced wholesale every time the
/// keyboard reads it — a row deleted here would only come back.
struct PersonalDictionaryView: View {
    /// Read once per appearance rather than observed. The keyboard writes this
    /// file from another process, and there is nothing to observe across that
    /// boundary — but nothing here is live either: a correction learned while
    /// this screen is open shows up the next time it is opened, which is soon
    /// enough for a list of words.
    @State private var lexicon = Lexicon()
    @State private var newTerm = ""
    @State private var showClearConfirmation = false
    @State private var correction: LexiconCorrectionDraft?

    var body: some View {
        Form {
            correctionsSection
            termsSection
            systemSection
            if !lexicon.pairs.isEmpty || !lexicon.terms.isEmpty {
                clearSection
            }
        }
        // Pushed from Settings, so it keeps Settings' surfaces: the system
        // grouped background and row fill, with only the face overridden. See
        // `SettingsSection`.
        .font(.parley.body)
        .environment(\.defaultMinListRowHeight, 48)
        .navigationTitle("Personal dictionary")
        .onAppear { lexicon = LexiconStore.load() }
        .sheet(item: $correction) { draft in
            LexiconCorrectionSheet(heard: draft.heard) { original, replacement in
                LexiconStore.recordConfirmed(original: original, replacement: replacement)
                lexicon = LexiconStore.load()
            }
        }
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
            Button {
                correction = LexiconCorrectionDraft(heard: "")
            } label: {
                Label("Add correction", systemImage: "plus")
                    .font(.parley.subheadlineEmphasized)
            }
            if lexicon.pairs.isEmpty {
                Text("Nothing learned yet.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
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
    }

    /// What was heard, an arrow, what the user meant — and how many times they
    /// have said so. The count is the honest thing to show: it is what decides
    /// whether the row is doing anything yet.
    private func correctionRow(_ pair: LexiconPair) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: pair.original)
                .foregroundStyle(Color(.secondaryLabel))
            Image(systemName: "arrow.right")
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
            Text(verbatim: pair.replacement)
                .font(.parley.bodyEmphasized)
            Spacer(minLength: 8)
            if pair.count >= Lexicon.autoApplyThreshold {
                // Verbatim: a digit and a multiplication sign read the same in
                // both localizations, and a catalog key for them would be
                // noise.
                Text(verbatim: "\(pair.count)×")
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
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
            SettingsSection.footer("Names, jargon, and anything else you say often. Parley listens for them when you dictate and keeps your spelling.")
        }
    }

    // MARK: from the system

    private var systemSection: some View {
        Section {
            if lexicon.systemTerms.isEmpty {
                Text("Nothing here yet. The Parley keyboard brings these in when it opens, with Full Access on.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
            } else {
                ForEach(lexicon.systemTerms, id: \.self) { term in
                    Text(verbatim: term)
                        .foregroundStyle(Color(.secondaryLabel))
                }
            }
        } header: {
            SettingsSection.header("From Contacts and Text Replacement")
        } footer: {
            SettingsSection.footer("Names from your contacts, and phrases you saved in Settings › General › Keyboard › Text Replacement. Parley listens for them after your own words. They refresh automatically whenever the Parley keyboard opens — change them there, not here.")
        }
    }

    private var clearSection: some View {
        Section {
            Button("Clear the dictionary", role: .destructive) {
                showClearConfirmation = true
            }
        }
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
