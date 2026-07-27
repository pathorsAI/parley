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
public actor SttRelayClient {
    public struct Options {
        public var relayURL: URL
        public var bearerToken: String
        /// Advisory model name; the relay forces the real model server-side.
        public var model: String
        public var languageHints: [String]?
        /// Billing attribution (`?feature=`) — parley-internal#29.
        public var feature: String

        public init(
            relayURL: URL = URL(string: "wss://api.parley.tw/stt/stream")!,
            bearerToken: String, model: String = "stt-rt-v5",
            languageHints: [String]? = nil, feature: String = "meeting"
        ) {
            self.relayURL = relayURL
            self.bearerToken = bearerToken
            self.model = model
            self.languageHints = languageHints
            self.feature = feature
        }
    }

    private let options: Options
    private let onEvent: @Sendable (SttRelayEvent) -> Void
    private var task: URLSessionWebSocketTask?
    private var parser: SonioxStreamParser?
    private var keepaliveTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?
    private var finalizeSent = false

    public init(options: Options, onEvent: @escaping @Sendable (SttRelayEvent) -> Void) {
        self.options = options
        self.onEvent = onEvent
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
        self.parser = SonioxStreamParser(source: "mix") { seg in sink(.segment(seg)) }

        task.resume()

        // Relay mode: api_key stays nil; the relay injects the master key.
        let config = SonioxProtocol.Config(
            apiKey: nil, model: options.model, languageHints: options.languageHints)
        let encoder = JSONEncoder()
        let frame = String(data: try encoder.encode(config), encoding: .utf8)!
        try await task.send(.string(frame))

        startKeepalive()
        startReadLoop()
    }

    /// Stream one chunk of 16 kHz mono PCM.
    public func send(pcm samples: [Int16]) async throws {
        guard let task else { return }
        try await task.send(.data(SonioxProtocol.pcmToLeBytes(samples)))
    }

    /// Input drained: send finalize and let the relay drain the tail. The
    /// socket stays open until the server closes it (or `finished` arrives).
    public func finish() async {
        guard let task, !finalizeSent else { return }
        finalizeSent = true
        keepaliveTask?.cancel()
        try? await task.send(.string(SonioxProtocol.finalizeFrame))
        // Deliberately no task.cancel() here — see the type doc.
    }

    /// Hard teardown (app shutdown, user abort).
    public func cancel() {
        keepaliveTask?.cancel()
        readTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
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
    }
}
