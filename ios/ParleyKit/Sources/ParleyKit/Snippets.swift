import Foundation

/// What kind of 常用資訊 a snippet is. The kind decides the icon, the default
/// label, which fields the keyboard suggests it in, and — for the two
/// identifiers — that the keyboard never shows it in full.
public enum SnippetKind: String, CaseIterable, Codable, Sendable, Identifiable {
    /// 姓名
    case name
    /// 手機
    case mobile
    /// 市話
    case phone
    /// Email
    case email
    /// 住家地址
    case homeAddress
    /// 公司地址
    case workAddress
    /// 身分證字號
    case nationalID
    /// 統一編號
    case taxID
    /// 自訂, with a label the user writes.
    case custom

    public var id: String { rawValue }

    /// 身分證字號 and 統一編號. The keyboard shows them masked
    /// (`Snippet.masked`) and inserts the full value only on a tap, and the
    /// value never goes anywhere else: not into the polish, the lexicon, a log,
    /// or the system pasteboard.
    public var isSensitive: Bool {
        self == .nationalID || self == .taxID
    }

    /// The kind's name, and the label a new snippet of it starts with. Kept in
    /// ParleyKit's catalog so the app's editor and the keyboard's panel can
    /// never call the same kind two different things.
    public var displayName: String {
        switch self {
        case .name: return String(localized: "Name", bundle: .module)
        case .mobile: return String(localized: "Mobile", bundle: .module)
        case .phone: return String(localized: "Landline", bundle: .module)
        case .email: return String(localized: "Email", bundle: .module)
        case .homeAddress: return String(localized: "Home address", bundle: .module)
        case .workAddress: return String(localized: "Work address", bundle: .module)
        case .nationalID: return String(localized: "National ID number", bundle: .module)
        case .taxID: return String(localized: "Tax ID number", bundle: .module)
        case .custom: return String(localized: "Custom", bundle: .module)
        }
    }

    /// An SF Symbol for the kind, the same in the app's editor and the
    /// keyboard's 常用 tab.
    public var symbolName: String {
        switch self {
        case .name: return "person"
        case .mobile: return "iphone"
        case .phone: return "phone"
        case .email: return "envelope"
        case .homeAddress: return "house"
        case .workAddress: return "building.2"
        case .nationalID: return "person.text.rectangle"
        case .taxID: return "building.columns"
        case .custom: return "star"
        }
    }
}

/// One piece of 常用資訊: the user's name, a phone number, an address, an ID.
public struct Snippet: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var kind: SnippetKind
    /// What the row is called. The kind's own name unless the user wrote one —
    /// and always the user's for `custom`.
    public var label: String
    public var value: String
    public var updatedAt: Date

    public init(
        id: UUID = UUID(), kind: SnippetKind, label: String, value: String,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.value = value
        self.updatedAt = updatedAt
    }

    /// Tolerant: a kind this build does not know reads as `custom`, so a row
    /// written by a later build is still a row rather than a decode failure.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        kind = (try? c.decode(SnippetKind.self, forKey: .kind)) ?? .custom
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        value = try c.decode(String.self, forKey: .value)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    }

    /// What the keyboard draws for the value: the value itself, or for a
    /// sensitive kind, `masked`.
    public var displayValue: String {
        kind.isSensitive ? Self.masked(value) : value
    }

    /// The first two and last two characters with a `•` for each one between —
    /// `A123456789` → `A1••••••89`. Four characters or fewer are dots
    /// throughout: showing "the first two and the last two" of a four-character
    /// value would be showing all of it.
    public static func masked(_ value: String) -> String {
        let chars = Array(value)
        guard chars.count > 4 else { return String(repeating: "•", count: chars.count) }
        return String(chars.prefix(2)) + String(repeating: "•", count: chars.count - 4)
            + String(chars.suffix(2))
    }

    /// The form a value is checked in — trimmed, without inner spaces or
    /// hyphens, uppercased — so `a123 456 789` typed with spaces still passes
    /// the 身分證字號 format hint as `A123456789`.
    public static func normalized(_ value: String) -> String {
        String(
            value.uppercased().filter { !$0.isWhitespace && $0 != "-" })
    }
}

/// The kind of field the keyboard is typing into, as far as 常用資訊 cares —
/// from the host's `textContentType` and `keyboardType`, mapped in the keyboard
/// (which has UIKit) and decided on here.
public enum SnippetField: String, Sendable, CaseIterable {
    case name
    case email
    case phone
    case address

    /// The kinds suggested in this field, in the order the chips show them.
    public var kinds: [SnippetKind] {
        switch self {
        case .name: return [.name]
        case .email: return [.email]
        case .phone: return [.mobile, .phone]
        case .address: return [.homeAddress, .workAddress]
        }
    }

    /// The snippets to suggest here: those of `kinds`, in that order, each
    /// kind's in the user's own order. Only suggested — the keyboard inserts
    /// nothing until one is tapped.
    public func suggestions(from snippets: [Snippet]) -> [Snippet] {
        kinds.flatMap { kind in
            snippets.filter {
                $0.kind == kind && !$0.value.trimmingCharacters(in: .whitespaces).isEmpty
            }
        }
    }
}

/// The shape of an email address or a phone number — what the editor's format
/// hints (`SnippetValidation`) are judged against. Generous in what it
/// accepts: a hint that fires on a real number is worse than one that misses a
/// typo.
public enum SnippetDetector {
    /// One `@`, something before it, and a dotted domain after it, with no
    /// whitespace anywhere.
    public static func isEmail(_ text: String) -> Bool {
        guard !text.contains(where: \.isWhitespace) else { return false }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty }
    }

    /// Digits with the punctuation phone numbers are written with — `+`,
    /// spaces, hyphens, dots, brackets, and `#` / `轉` / `ext` for an
    /// extension — and between 8 and 15 digits, which covers a Taiwanese
    /// landline without its area code up to the longest international number.
    public static func isPhone(_ text: String) -> Bool {
        var body = text
        for marker in ["轉", "ext.", "ext", "#"] {
            if let r = body.range(of: marker, options: .caseInsensitive) {
                body = String(body[..<r.lowerBound])
            }
        }
        let allowed = Set("0123456789+-(). ")
        guard body.allSatisfy({ allowed.contains($0) }) else { return false }
        let digits = body.filter(\.isNumber).count
        return (8...15).contains(digits)
    }
}

/// A light check on what the user typed into the editor: a hint under the
/// field, never a refusal. A value that fails it is still saved — a foreign
/// resident's ID, a company's extension, an address-shaped note are all
/// legitimate — but a mistyped 身分證字號 is worth one line of warning.
public enum SnippetValidation {
    public enum Hint: Equatable, Sendable {
        /// Not one letter and nine digits with a valid check digit.
        case nationalIDFormat
        /// Not eight digits.
        case taxIDFormat
        case emailFormat
        /// Not a Taiwanese mobile (09xx-xxx-xxx) nor an international number.
        case mobileFormat
        case phoneFormat
    }

    public static func hint(for kind: SnippetKind, value: String) -> Hint? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        switch kind {
        case .nationalID:
            return isTaiwanID(Snippet.normalized(trimmed)) ? nil : .nationalIDFormat
        case .taxID:
            let digits = Snippet.normalized(trimmed)
            return digits.count == 8 && digits.allSatisfy(\.isNumber) ? nil : .taxIDFormat
        case .email:
            return SnippetDetector.isEmail(trimmed) ? nil : .emailFormat
        case .mobile:
            let digits = trimmed.filter(\.isNumber)
            let taiwan = digits.hasPrefix("09") && digits.count == 10
            let international = trimmed.hasPrefix("+") && SnippetDetector.isPhone(trimmed)
            return taiwan || international ? nil : .mobileFormat
        case .phone:
            return SnippetDetector.isPhone(trimmed) ? nil : .phoneFormat
        case .name, .homeAddress, .workAddress, .custom:
            return nil
        }
    }

    /// The Republic of China national ID: a letter for the place of first
    /// registration, `1` / `2` (or `8` / `9` on the newer resident
    /// certificate), eight more digits, and a weighted check digit.
    public static func isTaiwanID(_ id: String) -> Bool {
        let chars = Array(id)
        guard chars.count == 10, let letter = chars.first,
            let code = letterCodes[letter],
            chars.dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }),
            let second = chars[1].wholeNumberValue, [1, 2, 8, 9].contains(second)
        else { return false }
        let digits = chars.dropFirst().compactMap(\.wholeNumberValue)
        var sum = code / 10 + (code % 10) * 9
        for (i, d) in digits.prefix(8).enumerated() { sum += d * (8 - i) }
        sum += digits[8]
        return sum % 10 == 0
    }

    private static let letterCodes: [Character: Int] = [
        "A": 10, "B": 11, "C": 12, "D": 13, "E": 14, "F": 15, "G": 16, "H": 17, "I": 34,
        "J": 18, "K": 19, "L": 20, "M": 21, "N": 22, "O": 35, "P": 23, "Q": 24, "R": 25,
        "S": 26, "T": 27, "U": 28, "V": 29, "W": 32, "X": 30, "Y": 31, "Z": 33,
    ]
}

/// The 常用資訊 on disk: `snippets.json` in the App Group container, written
/// with `FileProtectionType.complete` (see `ProtectedFile`), in the order the
/// user arranged them.
///
/// Edited in the app (Settings › 常用資訊) and only read by the keyboard.
/// Local only — never uploaded, never logged.
public final class SnippetStore: @unchecked Sendable {
    public static let fileName = "snippets.json"

    public let fileURL: URL
    private let lock = NSLock()

    public init(directory: URL) {
        fileURL = directory.appendingPathComponent(Self.fileName)
    }

    /// The store in the App Group container, or `nil` where it cannot be
    /// opened (a keyboard without Full Access).
    public static func shared() -> SnippetStore? {
        DictationChannel.container.map { SnippetStore(directory: $0) }
    }

    public func load() -> [Snippet] {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    /// The whole list, in order — the editor saves what it shows.
    public func save(_ snippets: [Snippet]) {
        lock.lock()
        defer { lock.unlock() }
        write(snippets)
    }

    private func read() -> [Snippet] {
        guard let data = ProtectedFile.read(fileURL),
            let rows = try? ProtectedFile.decoder.decode([LossyRow<Snippet>].self, from: data)
        else { return [] }
        return rows.compactMap(\.value)
    }

    private func write(_ snippets: [Snippet]) {
        guard let data = try? ProtectedFile.encoder.encode(snippets) else { return }
        ProtectedFile.write(data, to: fileURL)
    }
}

/// Decodes an element or shrugs, so one bad row costs one row rather than the
/// file. The snippets' own, rather than the lexicon's `Lossy`, so the two
/// files can change independently.
struct LossyRow<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// The polish's rewrite, offered back: what the keyboard's 「↩︎ 換回原文」
/// chip swaps in, and the test of whether it still can.
public struct RevertOffer: Equatable, Sendable {
    /// Exactly what the keyboard inserted — the polished text.
    public let inserted: String
    /// What the user said, before the polish.
    public let raw: String

    /// `nil` when there is nothing to revert to.
    public init?(inserted: String, raw: String) {
        guard !inserted.isEmpty, !raw.isEmpty, inserted != raw else { return nil }
        self.inserted = inserted
        self.raw = raw
    }

    /// How many `deleteBackward()` calls take the insertion back out: one per
    /// grapheme, the unit one call removes for text a dictation produces (see
    /// `KeyboardViewController.pickSuggestion` for the measurement).
    public var deleteCount: Int { inserted.count }

    /// The shortest clipped context that is still believed. The proxy's
    /// `documentContextBeforeInput` is clipped to a window iOS does not
    /// specify; a dictation longer than the window shows only its tail, and a
    /// tail this long is not a coincidence.
    static let minimumClippedMatch = 16

    /// Whether the cursor is still right after the inserted text, judged from
    /// the text before it. Swapping words that are not there would delete
    /// whatever is, so anything uncertain is a no: an empty or missing context,
    /// a context that does not end with the insertion, or a clipped one too
    /// short to tell.
    public func cursorIsAfterInsertion(context: String?) -> Bool {
        guard let context, !context.isEmpty else { return false }
        if context.count >= inserted.count { return context.hasSuffix(inserted) }
        return context.count >= Self.minimumClippedMatch && inserted.hasSuffix(context)
    }
}
