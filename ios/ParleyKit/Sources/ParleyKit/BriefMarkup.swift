import Foundation

/// The brief's markdown, read the way the phone draws it: paragraphs of text,
/// some of it bold, with `[m:ss]` timestamps that are links into the recording.
///
/// "Markdown-lite" on purpose. The brief is written by the analysis (or, for
/// the sample, by the script) and what it actually uses is bold lead-ins and
/// timestamps; a full markdown renderer would draw headings, tables and code
/// spans the summary has no room for, and `AttributedString(markdown:)` does not
/// know that `[1:34]` is a link. So the handful of constructs the brief uses are
/// parsed here, where they can be tested, and everything else stays as the
/// characters it is:
///
/// - `**…**` toggles bold. An unclosed `**` is just two asterisks.
/// - `[m:ss]` and `[h:mm:ss]` become timestamps. Anything else in square
///   brackets is text.
/// - A blank line separates paragraphs; a single newline is kept inside one.
/// - A line starting with `#`s is a heading and is drawn bold, without the
///   hashes; a line starting with `- ` or `* ` is a bullet and gets `• `.
public enum BriefMarkup {
    public enum Run: Equatable, Sendable {
        case text(String, bold: Bool)
        /// A moment on the recording. `label` is what the brief wrote, so the
        /// link reads exactly as the brief does.
        case timestamp(ms: UInt64, label: String)
    }

    /// The brief as paragraphs of runs. Empty paragraphs are dropped.
    public static func paragraphs(_ markdown: String) -> [[Run]] {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        var blocks: [[String]] = [[]]
        for line in normalized.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                if !(blocks.last ?? []).isEmpty { blocks.append([]) }
            } else {
                blocks[blocks.count - 1].append(line)
            }
        }
        return blocks.filter { !$0.isEmpty }.map { lines in
            var runs: [Run] = []
            for (index, line) in lines.enumerated() {
                if index > 0 { append(.text("\n", bold: false), to: &runs) }
                for run in parseLine(line) { append(run, to: &runs) }
            }
            return runs
        }
    }

    /// `m:ss` or `h:mm:ss` to milliseconds; nil for anything else.
    public static func milliseconds(_ clock: String) -> UInt64? {
        let parts = clock.split(separator: ":", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count),
            parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) })
        else { return nil }
        let numbers = parts.compactMap { UInt64($0) }
        guard numbers.count == parts.count else { return nil }
        // Every field after the first is a two-digit base-60 field.
        for (index, part) in parts.enumerated() where index > 0 {
            guard part.count == 2, numbers[index] < 60 else { return nil }
        }
        let seconds = numbers.reduce(0) { $0 * 60 + $1 }
        return seconds * 1000
    }

    // MARK: parsing

    private static func parseLine(_ raw: String) -> [Run] {
        var line = Substring(raw.trimmingCharacters(in: .whitespaces))
        var headingBold = false
        if line.hasPrefix("#") {
            let hashes = line.prefix(while: { $0 == "#" })
            let rest = line.dropFirst(hashes.count)
            if hashes.count <= 6, rest.hasPrefix(" ") {
                line = rest.drop(while: { $0 == " " })
                headingBold = true
            }
        }
        var prefix = ""
        if line.hasPrefix("- ") || line.hasPrefix("* ") {
            prefix = "• "
            line = line.dropFirst(2)
        }

        var runs: [Run] = []
        if !prefix.isEmpty { runs.append(.text(prefix, bold: false)) }
        var bold = false
        var buffer = ""
        let chars = Array(line)
        // Whether a later `**` exists to close an opening one — an unclosed
        // marker is literal text, not bold-to-the-end-of-the-line.
        func hasClosingMarker(after index: Int) -> Bool {
            var j = index
            while j + 1 < chars.count {
                if chars[j] == "*" && chars[j + 1] == "*" { return true }
                j += 1
            }
            return false
        }
        func flush() {
            guard !buffer.isEmpty else { return }
            runs.append(.text(buffer, bold: bold || headingBold))
            buffer = ""
        }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "*", i + 1 < chars.count, chars[i + 1] == "*",
                bold || hasClosingMarker(after: i + 2)
            {
                flush()
                bold.toggle()
                i += 2
                continue
            }
            if c == "[", let close = chars[(i + 1)...].firstIndex(of: "]") {
                let inside = String(chars[(i + 1)..<close])
                if let ms = milliseconds(inside) {
                    flush()
                    runs.append(.timestamp(ms: ms, label: inside))
                    i = close + 1
                    continue
                }
            }
            buffer.append(c)
            i += 1
        }
        flush()
        return runs
    }

    /// Merges adjacent text runs of the same weight, so a caller building one
    /// attributed string per paragraph does not have to.
    private static func append(_ run: Run, to runs: inout [Run]) {
        if case .text(let text, let bold) = run, case .text(let last, let lastBold)? = runs.last,
            bold == lastBold
        {
            runs[runs.count - 1] = .text(last + text, bold: bold)
        } else {
            runs.append(run)
        }
    }
}

/// Which turn of a transcript a moment on the recording belongs to — the
/// question a timestamp in the summary, a finding's 💡 and a waveform marker all
/// ask before they can take the reader somewhere.
public enum TranscriptAnchor {
    /// How far past the moment a turn may start and still count as "at" it.
    ///
    /// A brief writes `[0:08]` for a turn that starts at 8.9 s: clocks are
    /// floored to the second on the way into prose. Without the slack the
    /// timestamp would land on the turn *before* — the tail of somebody else's
    /// sentence.
    public static let slackMs: UInt64 = 999

    /// The last turn that has started by `ms` (with `slackMs`), or the first
    /// turn when the moment is before all of them. nil only for no turns.
    public static func turn(at ms: UInt64, in segments: [TranscriptSegment]) -> TranscriptSegment? {
        var found: TranscriptSegment?
        for segment in segments {
            if segment.startMs <= ms + slackMs { found = segment } else { break }
        }
        return found ?? segments.first
    }

    /// Where playback should go for a jump to `ms`: the turn's own start when
    /// the moment was a floored clock for it, so the reader hears the sentence
    /// from its first word; `ms` itself otherwise.
    public static func seekMs(for ms: UInt64, in segments: [TranscriptSegment]) -> UInt64 {
        guard let turn = turn(at: ms, in: segments), turn.startMs > ms else { return ms }
        return turn.startMs
    }
}
