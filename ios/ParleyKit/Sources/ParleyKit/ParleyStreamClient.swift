import Foundation
import os

/// Events surfaced by a hosted streaming session.
public enum SttRelayEvent: Sendable {
    case segment(TranscriptSegment)
    /// Stream ended: normally (`done`, or the server's close after `end`) or not.
    case closed(reason: String)
    /// An `error` frame, or a close that carries one of the protocol's error
    /// codes. `code` is the service's (`ParleyStreamProtocol.ErrorCode`) when
    /// it sent one — `quota_exceeded` is the case worth telling apart, because
    /// redialling a refused account only produces the same refusal on a
    /// slower clock.
    case error(String, code: String? = nil)
}

extension SttRelayEvent {
    /// The service says this account is out of transcription quota.
    /// Reconnecting cannot fix it; the next session is refused the same way.
    public static let quotaExceededCode = ParleyStreamProtocol.ErrorCode.quotaExceeded

    public var isQuotaExceeded: Bool {
        if case .error(_, Self.quotaExceededCode) = self { return true }
        return false
    }
}

/// WebSocket client for Parley's hosted streaming transcription, speaking
/// Parley's own protocol (`ParleyStreamProtocol`, `/stt/v2/stream`):
///
/// - `Authorization: Bearer <cloud session token>` on the handshake
/// - first frame is `start` (audio format, diarization, endpointing, and the
///   personal dictionary as `hints.terms`)
/// - `{"type":"keepalive"}` every 2 s, so a silent room is not an idle session
/// - binary frames are 16 kHz mono s16le PCM
/// - `ready` from the server means the session is up
/// - on stop: send `{"type":"end"}` and — critically — do NOT close the
///   socket. The server finalizes, streams the flushed tail back, sends
///   `done` and closes 1000; closing now would truncate the last utterance.
///
/// ## Audio goes in through a queue, not through the actor
///
/// Capture hands chunks over with `enqueue(pcm:)` from the audio thread. They
/// land in an `AsyncStream` that a single writer task drains in order. Two
/// things depend on this:
///
/// - **Order.** The obvious `Task { try await client.send(pcm:) }` per chunk
///   spawns one unstructured task per 100 ms of audio, and nothing orders
///   them: the socket could receive 3 s of speech with two chunks swapped,
///   which the provider transcribes as the garbled thing it now is.
/// - **The connect window.** The queue exists from `init`, so a caller may
///   start the microphone and enqueue immediately while `start()` is still
///   shaking hands. Nothing is consumed until the socket is up, and nothing is
///   lost — which is what lets recording begin the instant the button is
///   pressed instead of a round trip later.
///
/// One session per instance: after `finish()` or `cancel()` the client is
/// spent. Reconnecting means a new instance (see `Options.idPrefix`).
public actor ParleyStreamClient {
    /// The hosted streaming endpoint for a cloud base URL — the same host every
    /// other cloud call goes to (`CloudClient.defaultBaseURL`), over `wss`.
    public static func streamURL(base: URL = CloudClient.defaultBaseURL) -> URL {
        var comps = URLComponents(
            url: base.appendingPathComponent("stt/v2/stream"), resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"
        return comps.url!
    }

    public struct Options {
        public var streamURL: URL
        public var bearerToken: String
        /// Languages to expect, e.g. `["zh", "en"]`. Empty lets the service
        /// detect them.
        public var languages: [String]
        public var diarization: Bool
        public var endpointing: Bool
        /// Terms to bias recognition toward, best first — sent as
        /// `hints.terms` after `ParleyStreamProtocol.hints(for:)` cleans and
        /// caps them. Empty sends no `hints` at all.
        public var vocabulary: [String]
        /// Billing attribution (`?feature=`) — parley-internal#29.
        public var feature: String
        /// Stem for committed segment ids, defaulting to the source (`mix`).
        /// A recording that reopens its stream mid-meeting passes a distinct
        /// prefix per leg — see `SegmentBuilder.init`.
        public var idPrefix: String?
        /// Added to every timestamp this session emits, so a reconnected leg
        /// lands after the audio that preceded it rather than at 0.
        public var timeOffsetMs: UInt64

        public init(
            streamURL: URL = ParleyStreamClient.streamURL(),
            bearerToken: String, languages: [String] = [], diarization: Bool = true,
            endpointing: Bool = true, vocabulary: [String] = [],
            feature: String = "meeting", idPrefix: String? = nil, timeOffsetMs: UInt64 = 0
        ) {
            self.streamURL = streamURL
            self.bearerToken = bearerToken
            self.languages = languages
            self.diarization = diarization
            self.endpointing = endpointing
            self.vocabulary = vocabulary
            self.feature = feature
            self.idPrefix = idPrefix
            self.timeOffsetMs = timeOffsetMs
        }

        /// The `start` frame these options describe.
        public var startFrame: ParleyStreamProtocol.Start {
            ParleyStreamProtocol.Start(
                languages: languages, diarization: diarization, endpointing: endpointing,
                hints: ParleyStreamProtocol.hints(for: vocabulary))
        }
    }

    /// `start()` was called after `finish()` or `cancel()`. The client is one
    /// session, and that session is over.
    public struct Spent: Error {}

    /// The server refused the WebSocket upgrade with a plain HTTP status —
    /// there is no socket yet to carry an `error` frame. `401` unauthorized,
    /// `402` the account's quota is already used up, `429` too many sessions
    /// at once, `426` not an upgrade.
    public struct Rejected: Error, Equatable {
        public let status: Int

        public init(status: Int) {
            self.status = status
        }

        /// The account is out of transcription quota: the same refusal the
        /// in-session `quota_exceeded` is, and just as pointless to redial.
        public var isQuotaExceeded: Bool { status == 402 }
    }

    /// Chunks held between the audio thread and the socket. A tap chunk is
    /// ~85 ms, so this is ~45 s of slack — deep enough to cover a slow
    /// handshake or a stalled radio, shallow enough that a socket that never
    /// recovers cannot grow the process without bound. Overflow drops the
    /// oldest chunk: the meeting's audio file is written straight from the tap
    /// and is never at risk, so the worst case is a gap in the live transcript.
    private static let maxQueuedChunks = 512

    /// How long `finish()` waits for queued audio to reach the wire before
    /// sending the `end` frame anyway. A dead socket must not hold up the
    /// end of a meeting.
    private static let drainTimeout: Duration = .seconds(3)
    /// How long `finish()` then waits for the `end` frame itself to go out.
    /// Together with `drainTimeout` this is the longest `finish()` can take,
    /// which callers that must not hang on a dead socket rely on.
    private static let endTimeout: Duration = .seconds(1)
    /// The longest `finish()` can take, whatever the socket is doing.
    public static let finishBudget: Duration = drainTimeout + endTimeout

    /// When to stop believing a socket that has gone quiet. See `RelayLiveness`
    /// for why this is measured on ping/pong rather than on transcript traffic.
    private static let liveness = RelayLiveness.standard

    private let options: Options
    private let onEvent: @Sendable (SttRelayEvent) -> Void
    private var task: URLSessionWebSocketTask?
    private var parser: ParleyStreamParser?
    private var keepaliveTask: Task<Void, Never>?
    private var livenessTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?
    private var writerTask: Task<Void, Never>?
    private var endSent = false
    private var terminated = false
    /// The last moment the peer proved it was still there — a frame, or a pong.
    /// `RelayLiveness` measures the silence that follows it.
    private var lastProof = Date()

    private let outbound: AsyncStream<[Int16]>
    /// `nonisolated` on purpose: `enqueue(pcm:)` is called from the audio
    /// render thread and must not hop onto the actor to do it.
    private nonisolated let sink: AsyncStream<[Int16]>.Continuation
    private nonisolated let spent = OSAllocatedUnfairLock(initialState: false)

    public init(options: Options, onEvent: @escaping @Sendable (SttRelayEvent) -> Void) {
        self.options = options
        self.onEvent = onEvent
        let (stream, continuation) = AsyncStream<[Int16]>.makeStream(
            bufferingPolicy: .bufferingNewest(Self.maxQueuedChunks))
        self.outbound = stream
        self.sink = continuation
    }

    /// Connect, send the `start` frame, and start the read + keepalive loops.
    ///
    /// Returns once the socket is open and `start` is on the wire; the
    /// server's `ready` follows on the read loop. A refusal before the upgrade
    /// throws `Rejected` with its HTTP status (402: out of quota). One after
    /// it — `upstream_unavailable`, `bad_request`, `quota_exceeded` — arrives
    /// as an `.error` event, exactly as one later in the session would.
    public func start() async throws {
        guard !spent.withLock({ $0 }) else { throw Spent() }
        var comps = URLComponents(url: options.streamURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "feature", value: options.feature)]
        // The build header rides the upgrade request like any other header —
        // see `ParleyClientIdentity` for why this, and not `URLRequest(url:)`,
        // is how a request to the cloud is started.
        var req = ParleyClientIdentity.request(url: comps.url!)
        req.setValue("Bearer \(options.bearerToken)", forHTTPHeaderField: "Authorization")

        let task = URLSession.shared.webSocketTask(with: req)
        self.task = task

        let sink = self.onEvent
        self.parser = ParleyStreamParser(
            source: "mix", idPrefix: options.idPrefix, timeOffsetMs: options.timeOffsetMs
        ) { seg in sink(.segment(seg)) }

        task.resume()

        do {
            try await task.send(.string(try options.startFrame.encoded()))
        } catch {
            // A refused upgrade fails the first send; the status it was
            // refused with is on the handshake's response.
            if let status = (task.response as? HTTPURLResponse)?.statusCode, status >= 400 {
                throw Rejected(status: status)
            }
            throw error
        }
        guard !spent.withLock({ $0 }) else { throw Spent() }

        lastProof = Date()
        startKeepalive()
        startLiveness()
        startReadLoop()
        startWriter()
    }

    /// Hand one chunk of 16 kHz mono PCM to the writer. Non-blocking, safe from
    /// the audio thread, and safe before `start()` has finished connecting.
    public nonisolated func enqueue(pcm samples: [Int16]) {
        sink.yield(samples)
    }

    /// Input drained: flush what is still queued, send `end`, and let the
    /// server drain the tail. The socket stays open until `done` arrives or
    /// the server closes it.
    public func finish() async {
        spent.withLock { $0 = true }
        guard let task, !endSent else { return }
        endSent = true
        sink.finish()
        await drainWriter()
        keepaliveTask?.cancel()
        livenessTask?.cancel()
        // Bounded like the drain, and for the same reason: sends on one socket
        // go out in order, so behind a writer stuck on a stalled connection
        // the `end` is stuck too — and the liveness check that would have
        // declared that socket dead was cancelled on the line above.
        await Deadline.wait(atMost: Self.endTimeout) {
            try? await task.send(.string(ParleyStreamProtocol.endFrame))
        }
        // Deliberately no task.cancel() here — see the type doc.
    }

    /// Hard teardown (app shutdown, user abort, a leg being replaced by a
    /// reconnect). Idempotent, and callable from anywhere: closing the audio
    /// queue is synchronous, so a caller that abandons this client knows no
    /// further audio can reach it even before the socket has finished dying.
    public nonisolated func cancel() {
        spent.withLock { $0 = true }
        sink.finish()
        Task { await self.tearDown() }
    }

    private func tearDown() {
        terminated = true
        keepaliveTask?.cancel()
        livenessTask?.cancel()
        readTask?.cancel()
        writerTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    // MARK: internals

    /// Wait for the queued audio to reach the wire, but never longer than
    /// `drainTimeout` — the writer is blocked on a socket that may be gone.
    ///
    /// Not a task group racing a sleep, which is what this was: a group waits
    /// for every child before it returns, and awaiting an unstructured task's
    /// `value` does not stop when it is cancelled — so the timeout lost the
    /// race it was there to win, and `finish()` waited on a stalled socket for
    /// as long as the socket stayed stalled. See `Deadline`.
    private func drainWriter() async {
        guard let writerTask else { return }
        await Deadline.wait(atMost: Self.drainTimeout) { _ = await writerTask.value }
    }

    private func startWriter() {
        writerTask = Task { [weak self, outbound] in
            for await chunk in outbound {
                guard let self else { return }
                await self.write(chunk)
            }
        }
    }

    private func write(_ samples: [Int16]) async {
        guard let task, !terminated else { return }
        do {
            try await task.send(.data(ParleyStreamProtocol.pcmToLeBytes(samples)))
        } catch {
            // The read loop owns the error reporting; a failed write only means
            // the socket is on its way out, and the reader will say so.
            terminated = true
        }
    }

    private func startKeepalive() {
        let task = self.task
        keepaliveTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(ParleyStreamProtocol.keepaliveInterval))
                if Task.isCancelled { break }
                try? await task?.send(.string(ParleyStreamProtocol.keepaliveFrame))
            }
        }
    }

    private func startReadLoop() {
        readTask = Task {
            await self.readLoop()
        }
    }

    private func readLoop() async {
        guard let task, let parser else { return }
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                proveAlive()
                let payload: String
                switch message {
                case .string(let s): payload = s
                case .data(let d): payload = String(decoding: d, as: UTF8.self)
                @unknown default: continue
                }
                try parser.process(payload)
                if parser.finished {
                    onEvent(.closed(reason: "finished"))
                    break
                }
            } catch let err as ParleyStreamError {
                onEvent(.error("stream error \(err.code): \(err.message)", code: err.code))
                break
            } catch {
                // Server closed the socket (1000 after `done`) or transport
                // died. A close in the protocol's own range (4400 / 4402 /
                // 4408) is an error the server meant to report, even when the
                // `error` frame before it never made it here.
                let code = task.closeCode.rawValue
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if let errorCode = ParleyStreamProtocol.errorCode(forClose: code) {
                    onEvent(.error("stream closed \(code): \(errorCode)", code: errorCode))
                } else {
                    onEvent(.closed(reason: "close code=\(code) \(reason)"))
                }
                break
            }
        }
        // Nothing will ever read from this socket again; let the writer stop
        // rather than pile chunks into a dead connection.
        markTerminated()
    }

    /// Ping on a cadence, and give up on a socket that stops answering.
    ///
    /// The ping is not the detector — see `RelayLiveness`. On a half-open
    /// socket the completion handler never fires at all, which is why the
    /// verdict is a deadline on `lastProof` rather than anything this closure
    /// reports. What the ping buys is the *refresh*: a healthy server answers
    /// one even when the room is silent and no tokens are flowing, so a quiet
    /// meeting cannot be mistaken for a dead socket.
    private func startLiveness() {
        let policy = Self.liveness
        livenessTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: policy.checkInterval)
                if Task.isCancelled { break }
                guard let self else { return }
                if await self.checkLiveness(policy) { break }
            }
        }
    }

    /// Returns true when the socket has been declared dead and the loop is over.
    private func checkLiveness(_ policy: RelayLiveness) -> Bool {
        guard let task, !terminated else { return true }
        // `end` is in flight: the server is draining the recognizer's tail
        // and may legitimately say nothing for a beat. `finish()` owns the
        // deadline from here, and killing the socket now would truncate the
        // last utterance — the thing the `end` path exists to protect.
        guard !endSent else { return false }

        if policy.isDead(now: Date(), lastProof: lastProof) {
            let silence = Int(policy.deadlineSeconds)
            onEvent(.closed(reason: "no response for \(silence)s"))
            task.cancel(with: .goingAway, reason: nil)
            markTerminated()
            return true
        }

        task.sendPing { [weak self] error in
            guard error == nil else { return }
            Task { await self?.proveAlive() }
        }
        return false
    }

    private func proveAlive() {
        lastProof = Date()
    }

    private func markTerminated() {
        terminated = true
        sink.finish()
    }
}
