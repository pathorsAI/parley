import Foundation

/// Onboarding's microphone check, after the words are in: the self-introduction
/// becomes lines of the speaker background and dictionary terms, exactly as on
/// the desktop (`src/lib/onboarding/micCheck.ts`, `appendBackground` and
/// `removeBackgroundLines` in `memoryImport.ts`, `finish` in
/// `src/components/onboarding/MicStep.tsx`).
///
/// The pipeline: the relay's segments are assembled the way the desktop's
/// `CheckTranscript` does (committed runs in order, then the tentative tail);
/// the sentence is normalized (Traditional script, the user's replacements,
/// the product's own name fixed); the hosted model tidies it into 1–3
/// background lines, names and terms (without an answer, the sentence itself is
/// the line); the company and name the script's blanks held always become
/// terms; and the lines are appended to the background without re-formatting
/// what is there. Testing again takes the previous run's lines and the terms it
/// created back out first.
public enum MicIntro {
    // MARK: the transcript

    /// The live transcript of one check: committed runs in id order, then the
    /// tentative tail. Run ids end in a running number (`mix-3`); the tail is
    /// `{source}-tail` and is cleared by the run that settles it.
    public struct Transcript: Equatable, Sendable {
        private var finals: [String: String] = [:]
        private var interim = ""

        public init() {}

        public mutating func accept(_ segment: TranscriptSegment) {
            if segment.isFinal && !segment.id.hasSuffix("-tail") {
                finals[segment.id] = segment.text
                interim = ""
            } else {
                interim = segment.text
            }
        }

        public var text: String {
            let committed = finals.sorted { Self.order($0.key) < Self.order($1.key) }.map(\.value)
            return MicIntro.joinRuns(committed + [interim])
        }

        private static func order(_ id: String) -> Int {
            guard let dash = id.lastIndex(of: "-"), let n = Int(id[id.index(after: dash)...]) else {
                return .max
            }
            return n
        }
    }

    /// Join recognizer runs: CJK runs touch, Latin runs get a space between.
    public static func joinRuns(_ runs: [String]) -> String {
        var out = ""
        for raw in runs {
            let run = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !run.isEmpty else { continue }
            let glue =
                (out.last.map(isLatinOrDigit) ?? false) && (run.first.map(isLatinOrDigit) ?? false) ? " " : ""
            out += glue + run
        }
        return out
    }

    private static func isLatinOrDigit(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber)
    }

    // MARK: normalizing

    /// The product's name, which the check's script has the user say. It is
    /// the first thing Parley ever transcribes for them, so it must not get
    /// its own name wrong.
    public static let productName = "Parley"

    /// How recognizers mishear "Parley" — the desktop's
    /// `PRODUCT_NAME_MISHEARINGS`. Safe to rewrite only here: in "I use Parley
    /// to…" these can only mean the product.
    public static let productNameMishearings = [
        "parley", "parlay", "parlee", "parly", "parlie", "parle", "parli", "parlei", "parleigh", "parlé",
        "barley", "par lay", "par ley", "par lee", "pa ley", "pah ley",
        "帕雷", "帕利", "帕里", "帕莉", "帕麗", "帕力", "帕立", "帕勒", "帕來", "帕萊",
        "趴雷", "趴利", "啪雷", "派雷", "派利", "派力", "怕累", "怕雷", "巴雷",
    ]

    /// The desktop's `normalizeTranscriptText` then `fixProductName`: Traditional
    /// script, the user's own replacements (`replace`, LexiconStore on the
    /// phone), then every mishearing of the product's name rewritten and spaced
    /// off from Chinese the way the script writes it.
    public static func normalize(_ raw: String, replace: (String) -> String = { $0 }) -> String {
        let traditional = raw.applyingTransform(StringTransform("Hans-Hant"), reverse: false) ?? raw
        return fixProductName(replace(traditional))
    }

    /// Rewrite every mishearing of the product's name. ASCII variants match
    /// case-insensitively and only as whole words ("parle" stays inside
    /// "parlement"); a Chinese one is a plain replace. Longer variants first.
    public static func fixProductName(_ text: String) -> String {
        var out = text
        for variant in productNameMishearings.sorted(by: { $0.count > $1.count }) {
            if variant.unicodeScalars.allSatisfy(\.isASCII) {
                let pattern =
                    "(?<![A-Za-z0-9])" + NSRegularExpression.escapedPattern(for: variant) + "(?![A-Za-z0-9])"
                guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                    continue
                }
                out = re.stringByReplacingMatches(
                    in: out, range: NSRange(out.startIndex..., in: out), withTemplate: productName)
            } else {
                out = out.replacingOccurrences(of: variant, with: productName)
            }
        }
        out = out.replacingOccurrences(of: #"(\p{Script=Han})Parley"#, with: "$1 Parley", options: .regularExpression)
        out = out.replacingOccurrences(of: #"Parley(\p{Script=Han})"#, with: "Parley $1", options: .regularExpression)
        return out
    }

    // MARK: the summary

    /// What the introduction gives the setup.
    public struct Summary: Equatable, Sendable, Decodable {
        /// Lines for the speaker background.
        public var background: [String]
        /// Proper nouns for the dictionary.
        public var terms: [String]
        public var name: String
        public var company: String
        public var role: String

        public init(background: [String], terms: [String] = [], name: String = "", company: String = "", role: String = "") {
            self.background = background
            self.terms = terms
            self.name = name
            self.company = company
            self.role = role
        }

        /// The sentence itself as the one line: what a check leaves behind
        /// when there is no answer from the model.
        public static func plain(_ transcript: String) -> Summary {
            let said = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            return Summary(background: said.isEmpty ? [] : [said])
        }

        // Permissive: a missing field is empty rather than a lost answer.
        enum CodingKeys: String, CodingKey { case background, terms, name, company, role }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            background = (try? c.decode([String].self, forKey: .background)) ?? []
            terms = (try? c.decode([String].self, forKey: .terms)) ?? []
            name = (try? c.decode(String.self, forKey: .name)) ?? ""
            company = (try? c.decode(String.self, forKey: .company)) ?? ""
            role = (try? c.decode(String.self, forKey: .role)) ?? ""
        }
    }

    /// The desktop's `SYSTEM` prompt in `micCheck.ts`, word for word, with its
    /// JSON-mode and output-language suffixes (`shared/prompts/study.json`).
    static let systemPrompt =
        "The user introduced themself out loud to a meeting assistant; you get the speech-to-text "
        + "transcript, which may contain recognition errors. Return JSON:\n"
        + "- \"name\", \"company\", \"role\": as stated, or \"\" when not said.\n"
        + "- \"background\": 1 to 3 short factual lines about the user (who they are, what they use the "
        + "assistant for). No bullet characters, no line over 80 characters.\n"
        + "- \"terms\": the names said, for a speech recogniser: company names, people's names (the user's "
        + "included) and product names, each spelled as the user most likely writes it; one name per entry.\n"
        + "Never invent anything that wasn't said.\n"
        + "\n\nReturn your answer strictly as a single JSON object matching the provided schema. Use the "
        + "schema's property names EXACTLY (verbatim) — do not rename, translate, or add top-level keys."

    static func outputLanguage(chinese: Bool) -> String {
        let language = chinese ? "Traditional Chinese (繁體中文)" : "English"
        return "\n\nWrite ALL of your prose output (summaries, titles, explanations, advice) in \(language), "
            + "regardless of the language spoken in the transcript. Keep any VERBATIM quotes you cite from "
            + "the transcript in their original language."
    }

    static func request(transcript: String, chinese: Bool) -> CloudChat.Request {
        CloudChat.Request(
            model: FilingPrompt.model,
            temperature: 0.2,
            maxTokens: 400,
            messages: [
                .init(role: "system", content: systemPrompt + outputLanguage(chinese: chinese)),
                .init(role: "user", content: "TRANSCRIPT:\n\(transcript)"),
            ])
    }

    /// The model's answer, cleaned as the desktop's `summarizeIntro` cleans it,
    /// or nil when it could not be read.
    static func parse(_ content: String, transcript: String) -> Summary? {
        guard let json = FilingSuggester.firstJSONObject(in: content),
            let raw = try? JSONDecoder().decode(Summary.self, from: Data(json.utf8))
        else { return nil }
        let background = Array(cleanLines(raw.background).prefix(3))
        return Summary(
            background: background.isEmpty ? Summary.plain(transcript).background : background,
            terms: Array(cleanLines(raw.terms).prefix(8)),
            name: raw.name.trimmingCharacters(in: .whitespacesAndNewlines),
            company: raw.company.trimmingCharacters(in: .whitespacesAndNewlines),
            role: raw.role.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Ask the hosted model to tidy the introduction. Throws on transport
    /// failure; an unreadable answer is the plain sentence. The caller falls
    /// back to `Summary.plain` on a throw, as the desktop does.
    public static func summarize(
        _ transcript: String, chinese: Bool, cloud: CloudClient
    ) async throws -> Summary {
        let said = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return Summary.plain(said) }
        let body = try JSONEncoder().encode(request(transcript: said, chinese: chinese))
        let data = try await cloud.chatCompletion(body, feature: .meeting)
        guard let content = CloudChat.content(from: data) else { return Summary.plain(said) }
        return parse(content, transcript: said) ?? Summary.plain(said)
    }

    // MARK: names from the script

    /// Words that end a Chinese job title rather than a name (設計師, 經理…).
    private static let titleEndings: Set<Character> = ["師", "長", "理", "員", "監", "裁", "者", "生", "工", "手"]

    /// The longest text offered as a term: a name, not a sentence.
    public static let maxTermCharacters = 16

    /// The company and the speaker's name from the check's own script ("我是
    /// {company} 的 {name / title}…", "I'm {name / title} at {company}…"), for
    /// when there is no model answer — the desktop's `parseIntroScript`.
    public static func parseScript(_ text: String) -> (company: String, name: String) {
        func match(_ pattern: String, _ options: NSRegularExpression.Options = []) -> [String]? {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options),
                let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
            else { return nil }
            return (1..<m.numberOfRanges).map { i in
                Range(m.range(at: i), in: text).map { String(text[$0]) } ?? ""
            }
        }
        let zh = match(#"我是\s*(.+?)\s*的\s*([^，,。.]+)"#)
        let en = match(#"\bI(?:'| a)m\s+(.+?)\s+at\s+([^,.;]+)"#, [.caseInsensitive])
        let company = (zh?[0] ?? en?[1] ?? "").trimmingCharacters(in: .whitespaces)
        let who = zh?[1] ?? en?[0] ?? ""
        let words = who.components(separatedBy: CharacterSet(charactersIn: " /／、,，"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let name =
            words.first { word in
                if let first = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(first),
                    word.allSatisfy({ $0.isLetter || $0 == "'" || $0 == "-" })
                {
                    return true
                }
                let han = word.unicodeScalars.allSatisfy { $0.properties.isIdeographic }
                return han && (2...4).contains(word.count) && !(word.last.map(titleEndings.contains) ?? false)
            } ?? ""
        return (company.count <= maxTermCharacters ? company : "", name)
    }

    /// The introduction with its company and name always among the terms: what
    /// the model found, else what the script's blanks held — the desktop's
    /// `completeIntro`.
    public static func complete(_ summary: Summary, transcript: String) -> Summary {
        let parsed = parseScript(transcript)
        var out = summary
        out.company = summary.company.isEmpty ? parsed.company : summary.company
        out.name = summary.name.isEmpty ? parsed.name : summary.name
        for term in [out.company, out.name] where !term.isEmpty && !out.terms.contains(term) {
            out.terms.append(term)
        }
        return out
    }

    // MARK: the background

    /// A list marker at the start of a line: •, ‧, ·, -, *, +, or "1." / "1)".
    private static let listMarker = try! NSRegularExpression(
        pattern: #"^\s*(?:[•‧·]\s*|[-*+]\s+|\d{1,2}[.)]\s+)"#)

    /// Lines as the background compares them: trimmed, de-bulleted, non-empty,
    /// unique — the desktop's `cleanLines`.
    public static func cleanLines(_ lines: [String]) -> [String] {
        var out: [String] = []
        for raw in lines {
            let stripped = listMarker.stringByReplacingMatches(
                in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "")
            let line = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty && !out.contains(line) { out.append(line) }
        }
        return out
    }

    private static func rawLines(_ background: String) -> [String] {
        background.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    }

    /// Append the lines the background doesn't already have (compared without
    /// list markers), leaving what is there exactly as written. Returns the
    /// new text and the lines that went in.
    public static func append(_ add: [String], to background: String) -> (text: String, lines: [String]) {
        let have = Set(cleanLines(rawLines(background)))
        let fresh = cleanLines(add).filter { !have.contains($0) }
        guard !fresh.isEmpty else { return (background, []) }
        var base = background
        while let last = base.last, last.isWhitespace { base.removeLast() }
        return ((base.isEmpty ? "" : base + "\n") + fresh.joined(separator: "\n"), fresh)
    }

    /// Take out lines added earlier (compared without list markers), leaving
    /// the rest as written.
    public static func remove(_ lines: [String], from background: String) -> String {
        let drop = Set(cleanLines(lines))
        guard !drop.isEmpty else { return background }
        var out = rawLines(background)
            .filter { line in
                guard let clean = cleanLines([line]).first else { return true }
                return !drop.contains(clean)
            }
            .joined(separator: "\n")
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return out
    }

    /// What one check put into the setup, so testing again replaces it instead
    /// of piling a second introduction on top: the background lines it
    /// appended and the dictionary terms it created.
    public struct Run: Equatable, Sendable {
        public var lines: [String]
        public var createdTerms: [String]

        public init(lines: [String], createdTerms: [String]) {
            self.lines = lines
            self.createdTerms = createdTerms
        }
    }
}
