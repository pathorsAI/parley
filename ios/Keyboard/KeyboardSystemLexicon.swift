import ParleyKit
import UIKit
import os

/// The user's Text Replacement shortcuts, read once per process from the
/// lexicon the system lends a keyboard, and offered on the English bar.
///
/// `requestSupplementaryLexicon` also returns contact names. Those are dropped
/// before anything is copied out of the `UILexicon` (`SystemLexicon`): nothing
/// here stores, logs or forwards a name, because contact names do not leave the
/// phone and this keyboard has no on-device use for them worth holding.
///
/// The shortcuts stay in memory — no App Group, so no Full Access needed, and a
/// keyboard without it still expands "omw". The call is asynchronous, so it is
/// off the keystroke path: asked for once, filtered on a utility queue, and
/// handed back to the main thread as one small value. Per keystroke the bar
/// costs one dictionary lookup.
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
    /// the user edits Settings, which is rare enough that the next keyboard
    /// process picking it up is soon enough.
    ///
    /// `then` runs on the main thread once the shortcuts are in, so the bar can
    /// be re-read for a shortcut that was typed before they arrived.
    func load(from controller: UIInputViewController, then: @escaping () -> Void) {
        guard !requested else { return }
        requested = true
        controller.requestSupplementaryLexicon { [weak self] lexicon in
            // Shortcuts only, filtered before the copy: a contact's name is
            // never turned into a string this process keeps.
            let entries = lexicon.entries.compactMap { entry -> SystemLexicon.Entry? in
                guard
                    SystemLexicon.isShortcut(
                        userInput: entry.userInput, documentText: entry.documentText)
                else { return nil }
                return SystemLexicon.Entry(
                    userInput: entry.userInput, documentText: entry.documentText)
            }
            DispatchQueue.global(qos: .utility).async {
                let replacements = SystemLexicon.replacements(from: entries)
                Self.log.info("text replacement: \(replacements.count, privacy: .public) shortcuts")
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
