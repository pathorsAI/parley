import Foundation

/// Events surfaced by the relay session.
public enum SttRelayEvent: Sendable {
    case segment(TranscriptSegment)
    /// Stream ended: normally (`finished`/server close after finalize) or not.
    case closed(reason: String)
    case error(String)
}

/// WebSocket client for Parley's hosted STT relay
/// (`wss://api.parley.tw/stt/stream`), speaking the Soniox wire protocol with
/// the vendor key omitted — the relay injects it. Mirrors the desktop's
/// relay-mode behavior in `src-tauri/src/transcription/soniox.rs`:
///
/// - `Authorization: Bearer <cloud session token>` on the handshake
/// - first frame is the Soniox config (no `api_key` — the relay injects it)
/// - `{"type":"keepalive"}` every 2 s (Soniox 408s idle connections)
/// - binary frames are 16 kHz mono s16le PCM
/// - on stop: send `{"type":"finalize"}` and — critically — do NOT close the
///   socket. The relay must forward the finalize to Soniox and stream the
///   flushed tail back; closing now would truncate the last utterance. The
///   relay closes once Soniox finishes.
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
public actor SttRelayClient {
    public struct Options {
        public var relayURL: URL
        public var bearerToken: String
        /// Advisory model name; the relay forces the real model server-side.
        public var model: String
        public var languageHints: [String]?
        /// Billing attribution (`?feature=`) — parley-internal#29.
        public var feature: String
        /// Stem for committed segment ids, defaulting to the source (`mix`).
        /// A recording that reopens the relay mid-meeting passes a distinct
        /// prefix per leg — see `SegmentBuilder.init`.
        public var idPrefix: String?
        /// Added to every timestamp this session emits, so a reconnected leg
        /// lands after the audio that preceded it rather than at 0.
        public var timeOffsetMs: UInt64

        public init(
            relayURL: URL = URL(string: "wss://api.parley.tw/stt/stream")!,
            bearerToken: String, model: String = "stt-rt-v5",
            languageHints: [String]? = nil, feature: String = "meeting",
            idPrefix: String? = nil, timeOffsetMs: UInt64 = 0
        ) {
            self.relayURL = relayURL
            self.bearerToken = bearerToken
            self.model = model
            self.languageHints = languageHints
            self.feature = feature
            self.idPrefix = idPrefix
            self.timeOffsetMs = timeOffsetMs
        }
    }

    /// Chunks held between the audio thread and the socket. A tap chunk is
    /// ~85 ms, so this is ~45 s of slack — deep enough to cover a slow
    /// handshake or a stalled radio, shallow enough that a socket that never
    /// recovers cannot grow the process without bound. Overflow drops the
    /// oldest chunk: the meeting's audio file is written straight from the tap
    /// and is never at risk, so the worst case is a gap in the live transcript.
    private static let maxQueuedChunks = 512

    /// How long `finish()` waits for queued audio to reach the wire before
    /// sending the finalize frame anyway. A dead socket must not hold up the
    /// end of a meeting.
    private static let drainTimeout: Duration = .seconds(3)

    private let options: Options
    private let onEvent: @Sendable (SttRelayEvent) -> Void
    private var task: URLSessionWebSocketTask?
    private var parser: SonioxStreamParser?
    private var keepaliveTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?
    private var writerTask: Task<Void, Never>?
    private var finalizeSent = false
    private var terminated = false

    private let outbound: AsyncStream<[Int16]>
    /// `nonisolated` on purpose: `enqueue(pcm:)` is called from the audio
    /// render thread and must not hop onto the actor to do it.
    private nonisolated let sink: AsyncStream<[Int16]>.Continuation

    public init(options: Options, onEvent: @escaping @Sendable (SttRelayEvent) -> Void) {
        self.options = options
        self.onEvent = onEvent
        let (stream, continuation) = AsyncStream<[Int16]>.makeStream(
            bufferingPolicy: .bufferingNewest(Self.maxQueuedChunks))
        self.outbound = stream
        self.sink = continuation
    }

    /// Connect, send the config frame, and start the read + keepalive loops.
    public func start() async throws {
        var comps = URLComponents(url: options.relayURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "feature", value: options.feature)]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(options.bearerToken)", forHTTPHeaderField: "Authorization")

        let task = URLSession.shared.webSocketTask(with: req)
        self.task = task

        let sink = self.onEvent
        self.parser = SonioxStreamParser(
            source: "mix", idPrefix: options.idPrefix, timeOffsetMs: options.timeOffsetMs
        ) { seg in sink(.segment(seg)) }

        task.resume()

        // Relay mode: api_key stays nil; the relay injects the master key.
        let config = SonioxProtocol.Config(
            apiKey: nil, model: options.model, languageHints: options.languageHints)
        let encoder = JSONEncoder()
        let frame = String(data: try encoder.encode(config), encoding: .utf8)!
        try await task.send(.string(frame))

        startKeepalive()
        startReadLoop()
        startWriter()
    }

    /// Hand one chunk of 16 kHz mono PCM to the writer. Non-blocking, safe from
    /// the audio thread, and safe before `start()` has finished connecting.
    public nonisolated func enqueue(pcm samples: [Int16]) {
        sink.yield(samples)
    }

    /// Input drained: flush what is still queued, send finalize, and let the
    /// relay drain the tail. The socket stays open until the server closes it
    /// (or `finished` arrives).
    public func finish() async {
        guard let task, !finalizeSent else { return }
        finalizeSent = true
        sink.finish()
        await drainWriter()
        keepaliveTask?.cancel()
        try? await task.send(.string(SonioxProtocol.finalizeFrame))
        // Deliberately no task.cancel() here — see the type doc.
    }

    /// Hard teardown (app shutdown, user abort, a leg being replaced by a
    /// reconnect). Idempotent, and callable from anywhere: closing the audio
    /// queue is synchronous, so a caller that abandons this client knows no
    /// further audio can reach it even before the socket has finished dying.
    public nonisolated func cancel() {
        sink.finish()
        Task { await self.tearDown() }
    }

    private func tearDown() {
        terminated = true
        keepaliveTask?.cancel()
        readTask?.cancel()
        writerTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    // MARK: internals

    /// Wait for the queued audio to reach the wire, but never longer than
    /// `drainTimeout` — the writer is blocked on a socket that may be gone.
    private func drainWriter() async {
        guard let writerTask else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = await writerTask.value }
            group.addTask { try? await Task.sleep(for: Self.drainTimeout) }
            await group.next()
            group.cancelAll()
        }
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
            try await task.send(.data(SonioxProtocol.pcmToLeBytes(samples)))
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
                try? await Task.sleep(for: .seconds(SonioxProtocol.keepaliveInterval))
                if Task.isCancelled { break }
                try? await task?.send(.string(SonioxProtocol.keepaliveFrame))
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
            } catch let err as SonioxStreamError {
                onEvent(.error("relay error \(err.code): \(err.message)"))
                break
            } catch {
                // Server closed the socket (normal after drain) or transport
                // died. The relay's close codes (1000 drain, 1011 quota/idle)
                // surface here through URLSession.
                let code = task.closeCode.rawValue
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                onEvent(.closed(reason: "close code=\(code) \(reason)"))
                break
            }
        }
        // Nothing will ever read from this socket again; let the writer stop
        // rather than pile chunks into a dead connection.
        markTerminated()
    }

    private func markTerminated() {
        terminated = true
        sink.finish()
    }
}
