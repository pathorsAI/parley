import Foundation

/// A `multipart/form-data` body, for `POST /feedback` (§3): a `payload` text
/// field holding the report's JSON, and an optional `screenshot` JPEG.
///
/// Hand-built because Foundation has no builder for it and the format is small
/// enough to state in full. Two details are deliberate:
///
/// - The `payload` part carries **no** `Content-Type` and no filename. A form
///   parser (the Worker's `request.formData()` included) turns a part with a
///   filename into a `File`, and the server reads `payload` as a string.
/// - The boundary is random per body, so it cannot occur inside a JPEG by
///   anything but astronomical chance, and a test can still pin it.
public struct MultipartFormData: Sendable {
    public let boundary: String
    private var parts: [Data] = []

    public init(boundary: String = "parley-\(UUID().uuidString.lowercased())") {
        self.boundary = boundary
    }

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    public mutating func addText(name: String, value: String) {
        var part = Data()
        part.append("--\(boundary)\r\n")
        part.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        part.append(value)
        part.append("\r\n")
        parts.append(part)
    }

    public mutating func addFile(name: String, filename: String, contentType: String, data: Data) {
        var part = Data()
        part.append("--\(boundary)\r\n")
        part.append(
            "Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
        part.append("Content-Type: \(contentType)\r\n\r\n")
        part.append(data)
        part.append("\r\n")
        parts.append(part)
    }

    public func body() -> Data {
        var body = Data()
        parts.forEach { body.append($0) }
        body.append("--\(boundary)--\r\n")
        return body
    }

    /// The whole `POST /feedback` body.
    public static func feedback(payload: Data, screenshot: Data?, boundary: String? = nil)
        -> MultipartFormData
    {
        var form = boundary.map(MultipartFormData.init(boundary:)) ?? MultipartFormData()
        form.addText(name: "payload", value: String(decoding: payload, as: UTF8.self))
        if let screenshot {
            form.addFile(
                name: "screenshot", filename: "screenshot.jpg", contentType: "image/jpeg",
                data: screenshot)
        }
        return form
    }
}

extension Data {
    fileprivate mutating func append(_ string: String) {
        append(contentsOf: Array(string.utf8))
    }
}

/// Reports that have not reached the server yet, on disk, oldest first.
///
/// ## Why a report is queued before it is sent, every time
///
/// The moments a report is most wanted — a sync that keeps failing, a relay
/// that keeps dropping — are exactly the moments the network is least likely
/// to carry it. So "send" always means "put it in the queue, then drain the
/// queue": a report that cannot go now goes on the next launch, the next time
/// the network comes back, or right after the next sign-in, and the user who
/// tapped "Send" never has to tap it again.
///
/// ## Idempotent by id
///
/// The id is minted on the device and is the server's primary key; a resend of
/// the same id is answered 200 and stored once. That makes every retry here
/// safe, including the one that happens because the response to a successful
/// upload was lost. Enqueuing an id that is already queued replaces it rather
/// than adding a second copy.
///
/// ## Bounded
///
/// At most `capacity` reports; the oldest is dropped to make room. A phone that
/// is offline for a month does not accumulate a month of screenshots.
public actor FeedbackQueue {
    public static let capacity = 20

    public struct Item: Codable, Sendable, Equatable {
        public let id: String
        public let queuedAt: Date
        public var attempts: Int
        /// The report's JSON, exactly as it will be sent.
        public let payload: Data
        public let hasScreenshot: Bool
    }

    public struct DrainResult: Sendable, Equatable {
        public var delivered = 0
        /// Refused for good (a 4xx that no retry will change) and dropped.
        public var dropped = 0
        public var remaining = 0
        /// Why the pass stopped early, as a code; nil when it reached the end.
        public var stoppedOn: String?
    }

    private let directory: URL
    private var draining = false

    public init(directory: URL) {
        self.directory = directory
    }

    /// The app's queue, in Application Support — not Caches, which iOS may
    /// purge, and not the App Group, which the keyboard can read.
    public static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
            create: true)
        return base.appendingPathComponent("Parley/PendingFeedback", isDirectory: true)
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func manifestURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    private func screenshotURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).jpg")
    }

    public func enqueue(_ payload: FeedbackPayload, screenshot: Data?, now: Date = Date()) throws {
        try ensureDirectory()
        let data = try payload.jsonData()
        let existing = item(id: payload.id)
        let item = Item(
            id: payload.id, queuedAt: existing?.queuedAt ?? now,
            attempts: existing?.attempts ?? 0, payload: data, hasScreenshot: screenshot != nil)
        if let screenshot {
            try screenshot.write(to: screenshotURL(payload.id), options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: screenshotURL(payload.id))
        }
        try JSONEncoder().encode(item).write(to: manifestURL(payload.id), options: .atomic)
        trim()
    }

    public func items() -> [Item] {
        guard
            let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil)
        else { return [] }
        return
            files
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(Item.self, from: data)
            }
            .sorted { $0.queuedAt == $1.queuedAt ? $0.id < $1.id : $0.queuedAt < $1.queuedAt }
    }

    public var count: Int { items().count }

    private func item(id: String) -> Item? {
        guard let data = try? Data(contentsOf: manifestURL(id)) else { return nil }
        return try? JSONDecoder().decode(Item.self, from: data)
    }

    private func screenshot(for item: Item) -> Data? {
        item.hasScreenshot ? try? Data(contentsOf: screenshotURL(item.id)) : nil
    }

    private func remove(_ id: String) {
        try? FileManager.default.removeItem(at: manifestURL(id))
        try? FileManager.default.removeItem(at: screenshotURL(id))
    }

    private func trim() {
        let all = items()
        guard all.count > Self.capacity else { return }
        all.prefix(all.count - Self.capacity).forEach { remove($0.id) }
    }

    private func bumpAttempts(_ item: Item) {
        var updated = item
        updated.attempts += 1
        if let data = try? JSONEncoder().encode(updated) {
            try? data.write(to: manifestURL(item.id), options: .atomic)
        }
    }

    /// Send everything that is queued, oldest first, stopping at the first
    /// failure that the next item would hit too (no network, a 5xx, a 429).
    ///
    /// One pass at a time: launch, the network coming back and a sign-in can
    /// all ask within the same second, and two passes over the same directory
    /// would send each report twice — harmless to the server, wasteful on a
    /// phone that has just got its signal back. A caller that arrives during a
    /// pass is told what is left rather than waited for.
    public func drain(
        send: @Sendable (_ payload: Data, _ screenshot: Data?) async throws -> Void
    ) async -> DrainResult {
        var result = DrainResult()
        guard !draining else {
            result.remaining = count
            result.stoppedOn = "busy"
            return result
        }
        draining = true
        defer { draining = false }

        for item in items() {
            // The item may have been replaced or removed while an earlier send
            // was in flight; read it again rather than send a stale copy.
            guard let current = self.item(id: item.id) else { continue }
            do {
                try await send(current.payload, screenshot(for: current))
                remove(current.id)
                result.delivered += 1
            } catch let error where Self.isTerminal(error) {
                remove(current.id)
                result.dropped += 1
            } catch {
                bumpAttempts(current)
                result.stoppedOn = FeedbackErrorCode.of(error)
                break
            }
        }
        result.remaining = count
        return result
    }

    /// Whether the server's answer means this report can never be delivered.
    ///
    /// The same line `MeetingUploader` draws for recordings: a 4xx is the server
    /// objecting to the request itself — an unknown trigger (400), a body over
    /// the limit (413) — and the identical bytes will be refused identically
    /// forever. The exceptions are the ones time or another action clears: 401
    /// and 403 (the contract says the server answers anonymous rather than 401,
    /// but a proxy in front of it might not), 408, 425 and 429 (the daily
    /// limit). 5xx and transport failures are never terminal.
    ///
    /// 404 and 405 are in the exceptions too, unlike in `MeetingUploader`: here
    /// they mean the *route* is not there, which is a deploy that has not
    /// happened yet rather than a report that is wrong. An app that reaches
    /// users a day before the endpoint does must keep its reports, not drop
    /// every one of them.
    public static func isTerminal(_ error: Error) -> Bool {
        guard let cloud = error as? CloudError else { return false }
        switch cloud.status {
        case 401, 403, 404, 405, 408, 425, 429: return false
        case 400..<500: return true
        default: return false
        }
    }
}
