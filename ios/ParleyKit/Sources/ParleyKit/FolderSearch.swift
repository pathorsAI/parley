import Foundation

/// Finding a folder by name in the "Move to folder" picker.
///
/// A folder is a customer, so a working account ends up with dozens of them and
/// the picker has to be searchable. The rules are the ones `TranscriptSearch`
/// already uses for the same reasons: a plain substring match, so 「北風」 finds
/// 「北風工業」 without a tokeniser; case- and diacritic-insensitive, so "cafe"
/// finds "Café"; width-insensitive as well, because a zh-Hant keyboard can type
/// full-width Latin and "ＡＣＭＥ" should still find "Acme".
///
/// Kept here rather than in the sheet because what matches, and when the
/// picker offers to create the query as a new folder, are contracts worth a
/// test; the view is rows and a text field.
public enum FolderSearch {

    private static let options: String.CompareOptions = [
        .caseInsensitive, .diacriticInsensitive, .widthInsensitive,
    ]

    /// The query as the picker uses it: surrounding whitespace is not part of
    /// what anyone meant to search for, or to name a folder.
    public static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether `name` contains `query`. An empty (or all-whitespace) query
    /// matches everything — no search is the whole list.
    public static func matches(_ name: String, query: String) -> Bool {
        let q = normalized(query)
        guard !q.isEmpty else { return true }
        return name.range(of: q, options: options) != nil
    }

    /// `folders` narrowed to the ones matching `query`, in their original order.
    public static func filter(_ folders: [CloudFolder], query: String) -> [CloudFolder] {
        folders.filter { matches($0.name, query: query) }
    }

    /// Whether a folder is already called exactly `query`, by the same loose
    /// rules — so the picker does not offer to create a second "Acme" next to
    /// "acme".
    public static func hasExactMatch(_ folders: [CloudFolder], query: String) -> Bool {
        exactMatch(folders, query: query) != nil
    }

    /// The first folder called exactly `query`, by the same loose rules.
    public static func exactMatch(_ folders: [CloudFolder], query: String) -> CloudFolder? {
        let q = normalized(query)
        guard !q.isEmpty else { return nil }
        return folders.first {
            normalized($0.name).compare(q, options: options) == .orderedSame
        }
    }
}
