import ParleyKit
import UIKit
import os

/// The words the system lends a keyboard — contact names and the user's Text
/// Replacement list — read once per process and put to the two uses
/// `SystemLexicon` sorts them into.
///
/// - **Names** go to the App Group as the dictionary's system terms
///   (`LexiconStore.replaceSystemTerms`), where the app picks them up as
///   recognition terms for the next dictation. That write needs Full Access —
///   without it there is no App Group container to write into — and is simply
///   skipped then: the app keeps whatever was last written.
/// - **Shortcuts** stay here, in memory, for the English bar to offer their
///   expansions (`TextReplacements`). That needs no Full Access at all, so a
///   keyboard without it still expands "omw".
///
/// `requestSupplementaryLexicon` is asynchronous and the list can run to
/// thousands of contacts, so all of it happens off the keystroke path: asked
/// for once, sorted on a utility queue, and handed back to the main thread as
/// one small value. Per keystroke the bar costs one dictionary lookup.
final class KeyboardSystemLexicon {
    private static let log = Logger(
        subsystem: "com.pathors.parley.ios.keyboard", category: "lexicon")

    /// The shortcuts, once read. Empty until then, and for a user with none.
    private(set) var replacements = TextReplacements.none
    /// The expansion the bar is offering right now, if any — what a tap on it
    /// has to delete is the shortcut, which is not always the bar's
    /// `partialWord` (a shortcut can be "@@").
    private(set) var offered: TextReplacements.Match?
    private var requested = false

    /// Ask the system for its lexicon. Once per process: the list changes when
    /// the user edits Contacts or Settings, which relaunches nothing but is
    /// rare enough that the next keyboard process picking it up is soon enough.
    ///
    /// `then` runs on the main thread once the shortcuts are in, so the bar can
    /// be re-read for a shortcut that was typed before they arrived.
    func load(
        from controller: UIInputViewController, canWrite: Bool,
        then: @escaping () -> Void
    ) {
        guard !requested else { return }
        requested = true
        controller.requestSupplementaryLexicon { [weak self] lexicon in
            let entries = lexicon.entries.map {
                SystemLexicon.Entry(userInput: $0.userInput, documentText: $0.documentText)
            }
            DispatchQueue.global(qos: .utility).async {
                let (terms, replacements) = SystemLexicon.partition(entries)
                if canWrite { LexiconStore.replaceSystemTerms(terms) }
                Self.log.info(
                    "system lexicon: \(terms.count, privacy: .public) terms, \(replacements.count, privacy: .public) shortcuts, stored: \(canWrite, privacy: .public)"
                )
                DispatchQueue.main.async {
                    self?.replacements = replacements
                    then()
                }
            }
        }
    }

    /// The bar's words with the expansion of the shortcut in front of the
    /// cursor put first, remembering what was offered for `expansion(for:)`.
    func lead(_ suggestions: [String], before context: String?) -> [String] {
        offered = replacements.isEmpty ? nil : replacements.match(before: context)
        return TextReplacements.leading(offered, before: suggestions)
    }

    /// The shortcut a tapped word expands, when the word is the expansion the
    /// bar is offering.
    func expansion(for word: String) -> TextReplacements.Match? {
        guard let offered, offered.expansion == word else { return nil }
        return offered
    }
}
