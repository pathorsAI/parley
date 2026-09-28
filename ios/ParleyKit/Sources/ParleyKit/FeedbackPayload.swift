import Foundation

/// Arbitrary JSON, for the one field of a report whose shape is not ours: the
/// crash diagnostic MetricKit hands over (`diagnostics.crash`). Decoded rather
/// than carried as a string so the admin view can render it as the structure
/// it is, and so it can be trimmed by structure rather than cut mid-token.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Serialized size in bytes — the unit every budget in this file is in.
    var encodedSize: Int { (try? FeedbackPayload.encoder.encode(self).count) ?? 0 }
}

/// What a report says about the app, the phone and the moment — §5 of the
/// shared spec, field for field. Every field is optional on the wire and
/// omitted when unknown; `Codable`'s synthesized encoder already leaves out a
/// nil optional, which is exactly "omitted".
///
/// Nothing in here is the user's content. The recording is referred to by id
/// and described by numbers (duration, segment count, where the words stop);
/// the transcript itself never enters this type, and the log is scrubbed on its
/// way in (see `DiagnosticsScrubber`).
public struct FeedbackDiagnostics: Codable, Equatable, Sendable {
    public struct App: Codable, Equatable, Sendable {
        public var version: String
        public var build: String
        public init(version: String, build: String) {
            self.version = version
            self.build = build
        }
    }

    public struct OS: Codable, Equatable, Sendable {
        public var name: String
        public var version: String
        public init(name: String, version: String) {
            self.name = name
            self.version = version
        }
    }

    public struct Device: Codable, Equatable, Sendable {
        public var model: String
        public var locale: String
        public var timezone: String
        public init(model: String, locale: String, timezone: String) {
            self.model = model
            self.locale = locale
            self.timezone = timezone
        }
    }

    public struct Context: Codable, Equatable, Sendable {
        public var recordingId: String?
        public var recordingDurationMs: Int?
        public var transcriptSegments: Int?
        public var lastSegmentEndMs: Int?
        /// `builtInMic | bluetoothA2DP | bluetoothHFP | wired | usb | other`
        public var audioRoute: String?
        /// `granted | denied | undetermined`
        public var micPermission: String?
        public var micRecoveries: Int?
        public var syncPendingCount: Int?
        public var syncLastError: String?
        public var signedIn: Bool?

        public init(
            recordingId: String? = nil, recordingDurationMs: Int? = nil,
            transcriptSegments: Int? = nil, lastSegmentEndMs: Int? = nil,
            audioRoute: String? = nil, micPermission: String? = nil,
            micRecoveries: Int? = nil, syncPendingCount: Int? = nil,
            syncLastError: String? = nil, signedIn: Bool? = nil
        ) {
            self.recordingId = recordingId
            self.recordingDurationMs = recordingDurationMs
            self.transcriptSegments = transcriptSegments
            self.lastSegmentEndMs = lastSegmentEndMs
            self.audioRoute = audioRoute
            self.micPermission = micPermission
            self.micRecoveries = micRecoveries
            self.syncPendingCount = syncPendingCount
            self.syncLastError = syncLastError
            self.signedIn = signedIn
        }

        /// Fill in whatever `other` knows and this does not. A trigger knows
        /// the recording; the collector knows the phone; neither should have to
        /// know the other's half.
        public func merging(_ other: Context) -> Context {
            Context(
                recordingId: recordingId ?? other.recordingId,
                recordingDurationMs: recordingDurationMs ?? other.recordingDurationMs,
                transcriptSegments: transcriptSegments ?? other.transcriptSegments,
                lastSegmentEndMs: lastSegmentEndMs ?? other.lastSegmentEndMs,
                audioRoute: audioRoute ?? other.audioRoute,
                micPermission: micPermission ?? other.micPermission,
                micRecoveries: micRecoveries ?? other.micRecoveries,
                syncPendingCount: syncPendingCount ?? other.syncPendingCount,
                syncLastError: syncLastError ?? other.syncLastError,
                signedIn: signedIn ?? other.signedIn)
        }
    }

    public struct RecentError: Codable, Equatable, Sendable {
        /// Epoch milliseconds, like every other timestamp on the wire.
        public var at: Int64
        public var code: String
        public var message: String
        public init(at: Int64, code: String, message: String) {
            self.at = at
            self.code = code
            self.message = message
        }
    }

    public var app: App?
    public var os: OS?
    public var device: Device?
    public var context: Context?
    public var recentErrors: [RecentError]?
    public var log: String?
    public var crash: JSONValue?

    public init(
        app: App? = nil, os: OS? = nil, device: Device? = nil, context: Context? = nil,
        recentErrors: [RecentError]? = nil, log: String? = nil, crash: JSONValue? = nil
    ) {
        self.app = app
        self.os = os
        self.device = device
        self.context = context
        self.recentErrors = recentErrors
        self.log = log
        self.crash = crash
    }

    /// The server refuses a `diagnostics` object over 96 KB with a 413, and a
    /// refused report sitting in the offline queue would be retried forever —
    /// so the client never sends one. The log (the largest and least precious
    /// part) is trimmed first, from its *oldest* end, because the lines nearest
    /// the report are the ones that explain it; then the crash, then the error
    /// list. The rest is a few hundred bytes and always fits.
    public static let maxEncodedBytes = 96 * 1024
    /// §5: "最多 50 KB". Also enforced where the log is collected; repeated here
    /// so a report built by hand cannot exceed it either.
    public static let maxLogBytes = 50 * 1024
    /// §5: the crash object is cut to 48 KB.
    public static let maxCrashBytes = 48 * 1024

    public func fittingBudget(maxBytes: Int = FeedbackDiagnostics.maxEncodedBytes)
        -> FeedbackDiagnostics
    {
        var fitted = self
        if let log = fitted.log { fitted.log = Self.tail(of: log, maxBytes: Self.maxLogBytes) }
        if let crash = fitted.crash, crash.encodedSize > Self.maxCrashBytes {
            fitted.crash = CrashDiagnosticJSON.fit(crash, limit: Self.maxCrashBytes)
        }
        func size() -> Int { (try? FeedbackPayload.encoder.encode(fitted).count) ?? .max }
        var overshoot = size() - maxBytes
        if overshoot > 0, let log = fitted.log {
            let keep = max(0, log.utf8.count - overshoot - 64)
            fitted.log = keep > 0 ? Self.tail(of: log, maxBytes: keep) : nil
            overshoot = size() - maxBytes
        }
        if overshoot > 0, let crash = fitted.crash {
            let keep = max(1024, crash.encodedSize - overshoot - 256)
            fitted.crash = CrashDiagnosticJSON.fit(crash, limit: keep)
            overshoot = size() - maxBytes
        }
        if overshoot > 0 { fitted.recentErrors = nil }
        return fitted
    }

    /// The last `maxBytes` of `text`, cut at a line boundary so the first line
    /// is not half a line, and never inside a multi-byte character.
    static func tail(of text: String, maxBytes: Int) -> String {
        let utf8 = Array(text.utf8)
        guard utf8.count > maxBytes else { return text }
        var start = utf8.count - maxBytes
        // Step forward past UTF-8 continuation bytes (10xxxxxx).
        while start < utf8.count, utf8[start] & 0xC0 == 0x80 { start += 1 }
        var cut = String(decoding: utf8[start...], as: UTF8.self)
        if let newline = cut.firstIndex(of: "\n") {
            cut = String(cut[cut.index(after: newline)...])
        }
        return cut
    }
}

/// The JSON body of the multipart `payload` field (§3).
public struct FeedbackPayload: Codable, Equatable, Sendable {
    /// Minted on the device, lowercased like every other id this app mints. It
    /// is the idempotency key: the offline queue can resend a report as many
    /// times as the network makes it, and the server stores it once.
    public var id: String
    public var trigger: FeedbackTrigger
    public var recordingId: String?
    public var message: String?
    public var tags: [String]?
    public var diagnostics: FeedbackDiagnostics

    /// §2: the server truncates beyond 2000 characters and keeps at most eight
    /// tags of 32 characters. Doing the same here means what the user sees in
    /// the sheet is what arrives, rather than something the server edited.
    public static let maxMessageLength = 2_000
    public static let maxTags = 8
    public static let maxTagLength = 32

    public init(
        id: String = UUID().uuidString.lowercased(), trigger: FeedbackTrigger,
        recordingId: String? = nil, message: String? = nil, tags: [String]? = nil,
        diagnostics: FeedbackDiagnostics
    ) {
        self.id = id
        self.trigger = trigger
        self.recordingId = recordingId
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.message = trimmed.isEmpty ? nil : String(trimmed.prefix(Self.maxMessageLength))
        let cleanTags = (tags ?? []).map { String($0.prefix(Self.maxTagLength)) }
            .filter { !$0.isEmpty }.prefix(Self.maxTags)
        self.tags = cleanTags.isEmpty ? nil : Array(cleanTags)
        self.diagnostics = diagnostics.fittingBudget()
    }

    /// Sorted keys so the same report always serializes to the same bytes —
    /// which is what lets a test pin the body, and costs nothing.
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    public func jsonData() throws -> Data { try Self.encoder.encode(self) }
}

/// Cutting a MetricKit diagnostic down to size without turning it into
/// something no JSON parser will read.
///
/// `MXCrashDiagnostic.jsonRepresentation()` is small for most crashes and very
/// large for a few (deep recursion, many threads). Byte-slicing it would leave
/// an unterminated document. So the cut is structural: first drop every call
/// stack but the one attributed to the crashing thread — the one that says
/// *where* it crashed, which is the only question the admin inbox asks of it —
/// and only if that is still too big, keep the metadata and a text prefix of
/// the call-stack tree, flagged as truncated.
public enum CrashDiagnosticJSON {
    public static func decode(_ data: Data, limit: Int = FeedbackDiagnostics.maxCrashBytes)
        -> JSONValue
    {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            let text = String(decoding: data.prefix(limit - 64), as: UTF8.self)
            return .object(["unparsed": .string(text), "truncated": .bool(true)])
        }
        return fit(value, limit: limit)
    }

    public static func fit(_ value: JSONValue, limit: Int) -> JSONValue {
        guard value.encodedSize > limit else { return value }
        guard case .object(var object) = value else {
            return .object(["truncated": .bool(true), "text": .string(prefixText(value, limit))])
        }

        // Step 1: the attributed thread only.
        if case .object(var tree)? = object["callStackTree"],
            case .array(let stacks)? = tree["callStacks"]
        {
            let attributed = stacks.filter {
                if case .object(let s) = $0, case .bool(true)? = s["threadAttributed"] {
                    return true
                }
                return false
            }
            if !attributed.isEmpty, attributed.count < stacks.count {
                tree["callStacks"] = .array(attributed)
                object["callStackTree"] = .object(tree)
                object["truncated"] = .string("attributed_thread_only")
                if JSONValue.object(object).encodedSize <= limit { return .object(object) }
            }
        }

        // Step 2: replace the largest member with a text prefix of itself.
        guard
            let (key, largest) = object.max(by: { $0.value.encodedSize < $1.value.encodedSize })
        else { return .object(object) }
        object[key] = .null
        let room = limit - JSONValue.object(object).encodedSize - 128
        object[key] = .string(prefixText(largest, max(0, room)))
        object["truncated"] = .bool(true)
        if JSONValue.object(object).encodedSize <= limit { return .object(object) }
        return .object(["truncated": .bool(true), "text": .string(prefixText(value, limit - 128))])
    }

    /// The first `bytes` of the value's JSON text. As a *string* inside the
    /// report, so the report stays valid even though this text is not.
    ///
    /// The budget is measured on the escaped form: a prefix of JSON text is
    /// full of quotes, and every one of them costs a backslash once it is a
    /// string. Shrinking until the escaped string fits is a handful of passes
    /// at most, and it is the only way to be sure.
    private static func prefixText(_ value: JSONValue, _ bytes: Int) -> String {
        guard bytes > 0, let data = try? FeedbackPayload.encoder.encode(value) else { return "" }
        var budget = bytes
        while budget > 0 {
            let text = String(decoding: data.prefix(budget), as: UTF8.self)
            if JSONValue.string(text).encodedSize <= bytes { return text }
            budget = budget * 3 / 4
        }
        return ""
    }
}
