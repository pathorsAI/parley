import Foundation

/// Everything the app logs goes through `Logger(subsystem: ParleyLog.subsystem,
/// category: …)` with one of these categories, and a report's `log` field is
/// built from exactly these categories and no others.
///
/// ## An allowlist, not a denylist
///
/// The promise a report makes is that no transcript text, typed text, token or
/// email address leaves the phone. A denylist ("drop the categories that log
/// transcripts") keeps that promise only until someone adds a category and
/// forgets to list it. An allowlist fails the other way — a new category is
/// simply absent from reports until somebody decides it is safe to add here —
/// which is the direction to fail in.
///
/// Every category listed here logs control flow and error codes only. Today no
/// logger in the app logs transcript or typed text at all; the rule for the
/// day one does is that it gets a category that is *not* in this list.
///
/// The keyboard extension logs under its own subsystem and runs in its own
/// process, so `OSLogStore(scope: .currentProcessIdentifier)` in the app could
/// not read it even if the filter let it through — the keyboard stays entirely
/// out of this.
public enum ParleyLog {
    public static let subsystem = "com.pathors.parley"

    public enum Category: String, CaseIterable, Sendable {
        /// Upload queue and backfill queue: counts, ids, error codes.
        case sync = "Sync"
        /// Meeting recorder: relay legs, reconnects, close codes.
        case recording = "Recording"
        /// Microphone capture: interruptions, rebuilds, losses.
        case capture = "Capture"
        /// The feedback module itself: queue drains, MetricKit deliveries.
        case feedback = "Feedback"
        /// Pre-existing: dictation timing ("mic start took 180 ms").
        case dictation = "Dictation"
        /// Pre-existing: Live Activity refusals.
        case micActivity = "MicActivity"
    }

    public static let reportableCategories: Set<String> = Set(Category.allCases.map(\.rawValue))
}

/// The last line of defence between a log line and a report.
///
/// Defence in depth rather than the primary control — the primary control is
/// that nothing in `ParleyLog.reportableCategories` logs user content in the
/// first place. This catches the things that slip into otherwise innocent
/// lines: an email in an error body the server echoed, a bearer token in a
/// URL someone logged, a session token in a query string.
public enum DiagnosticsScrubber {
    private static let rules: [(NSRegularExpression, String)] = [
        // JWTs first, before the generic long-token rule eats them piecemeal.
        (#"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}"#, "<jwt>"),
        (#"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"#, "Bearer <token>"),
        (
            #"(?i)\b(token|access_token|id_token|refresh_token|api_key|apikey|key|secret|password|session)=([^&\s"'<>]+)"#,
            "$1=<redacted>"
        ),
        (#"(?i)"(token|access_token|id_token|refresh_token|api_key|apikey|secret|password|session)"\s*:\s*"[^"]*""#, "\"$1\":\"<redacted>\""),
        (#"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, "<email>"),
        // Opaque credentials: 32+ characters of token alphabet with no
        // separators. Hyphens are deliberately *not* in the class, so a UUID —
        // the recording ids that make a report useful — is never mistaken for
        // one: its longest hyphen-free run is 12 characters.
        (#"\b[A-Za-z0-9_+/=]{32,}\b"#, "<redacted>"),
    ].compactMap { pattern, template in
        (try? NSRegularExpression(pattern: pattern)).map { ($0, template) }
    }

    public static func scrub(_ text: String) -> String {
        var result = text
        for (regex, template) in rules {
            let range = NSRange(result.startIndex..., in: result)
            result = regex.stringByReplacingMatches(
                in: result, range: range, withTemplate: template)
        }
        return result
    }
}

/// One line read back out of the unified log, reduced to what the filter needs.
public struct DiagnosticLogEntry: Sendable, Equatable {
    public var date: Date
    public var subsystem: String
    public var category: String
    public var level: String
    public var message: String

    public init(date: Date, subsystem: String, category: String, level: String, message: String) {
        self.date = date
        self.subsystem = subsystem
        self.category = category
        self.level = level
        self.message = message
    }
}

/// Turns raw log entries into the `log` string of a report: our subsystem, the
/// reportable categories, scrubbed, newest kept, at most 200 lines and 50 KB.
public enum DiagnosticLogFormatter {
    public static let maxLines = 200

    public static func format(
        _ entries: [DiagnosticLogEntry], maxBytes: Int = FeedbackDiagnostics.maxLogBytes
    ) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let lines =
            entries
            .filter {
                $0.subsystem == ParleyLog.subsystem
                    && ParleyLog.reportableCategories.contains($0.category)
            }
            .sorted { $0.date < $1.date }
            .suffix(maxLines)
            .map { entry -> String in
                // One line per entry: a message with a newline in it would
                // otherwise be split by the tail cut into a half that belongs
                // to nobody.
                let flat = entry.message.replacingOccurrences(of: "\n", with: " ⏎ ")
                return
                    "\(formatter.string(from: entry.date)) \(entry.level) [\(entry.category)] \(DiagnosticsScrubber.scrub(flat))"
            }
        return FeedbackDiagnostics.tail(of: lines.joined(separator: "\n"), maxBytes: maxBytes)
    }
}

/// The last few things that went wrong, as codes — `recentErrors` in a report.
///
/// Kept by the app rather than recovered from the log at report time, because
/// the log is best-effort (iOS may have rotated it, and a crash report is sent
/// from a *later* process that cannot read the earlier one's entries at all)
/// and this list is the part of a report an engineer reads first.
public struct RecentErrorLog: Codable, Equatable, Sendable {
    public static let capacity = 20
    public static let maxMessageLength = 200

    public private(set) var entries: [FeedbackDiagnostics.RecentError] = []

    public init() {}

    /// Record one failure. The message is scrubbed and capped here, on the way
    /// in, so nothing unscrubbed is ever persisted to be sent later.
    public mutating func record(code: String, message: String, at date: Date = Date()) {
        let clean = String(DiagnosticsScrubber.scrub(message).prefix(Self.maxMessageLength))
        entries.append(
            .init(at: Int64(date.timeIntervalSince1970 * 1000), code: code, message: clean))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    public var lastCode: String? { entries.last?.code }
}
