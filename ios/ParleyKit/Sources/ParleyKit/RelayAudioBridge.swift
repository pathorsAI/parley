import Foundation

/// Anything that can accept a chunk of 16 kHz mono PCM from the audio thread.
/// `SttRelayClient` is the only production conformer; tests use a recorder.
public protocol PcmSink: AnyObject, Sendable {
    func enqueue(pcm samples: [Int16])
}

extension SttRelayClient: PcmSink {}

/// Routes microphone chunks to whichever relay leg is current — and **holds
/// them while there is none**.
///
/// A relay session cannot be resumed: the socket carries one Soniox session,
/// and a dropped socket means a fresh leg with its own clock starting at zero
/// (which is what `SttRelayClient.Options.idPrefix` and `timeOffsetMs` are
/// for). The gap between the two legs is the interesting part. Without this
/// type it is simply thrown away: the recording keeps a perfect audio file,
/// but the words spoken during a five-second blip never reach the relay and
/// never appear in the live transcript.
///
/// So the bridge is the audio thread's only counterparty, and it is always
/// there:
///
/// ```
/// mic ──▶ bridge ──┬── attached  ──▶ current leg
///                  └── holding   ──▶ ring of held chunks, flushed into the
///                                    next leg the moment it is created
/// ```
///
/// ## The clock
///
/// The bridge counts every sample it is ever handed, so it always knows the
/// position of the audio passing through it (`capturedMilliseconds`). When a
/// new leg is attached, the offset that leg must use is not "now" — it is the
/// position of the **oldest sample the new leg will actually receive**, which
/// is the front of the hold buffer. Using "now" would place a whole gap's
/// worth of speech in the future, after the audio that follows it.
///
/// ## The bound
///
/// Holding is capped (`holdLimitMilliseconds`) and overflow drops the *oldest*
/// chunk, which also advances the front of the buffer — so the offset handed
/// to the next leg stays honest about what that leg is being fed. The audio
/// file is written straight from the tap and is never at risk here; the worst
/// case is that the live transcript is missing the beginning of a very long
/// outage, and the cloud transcribes the upload anyway.
///
/// `@unchecked Sendable` because the single mutable box is guarded by `lock`.
/// The lock is held only for pointer swaps and array appends — never across a
/// socket write, which happens inside the sink's own queue.
///
/// One producer: `send` expects the single audio thread `AudioCapture` calls
/// it from. Ordering across two concurrent producers is not something a lock
/// this shallow can promise, and the pipeline has never had two.
public final class RelayAudioBridge: @unchecked Sendable {
    /// Default hold window. 45 s comfortably covers the reconnect backoff
    /// ladder (1, 2, 4, 8, 15, 15 …) plus a slow handshake on a cold radio,
    /// and costs at most 16 000 × 2 × 45 ≈ 1.4 MB of Int16 while it is full.
    public static let defaultHoldLimit: Duration = .seconds(45)

    private let sampleRate: UInt64
    private let holdLimitSamples: UInt64
    private let lock = NSLock()

    /// The leg audio is flowing to, or nil while holding.
    private var sink: PcmSink?
    /// True between `hold()` and the next `attach`/`discard`.
    private var holding = false
    private var held: [[Int16]] = []
    private var heldSamples: UInt64 = 0
    /// Samples handed to the bridge since `reset()`, i.e. the position of the
    /// next sample to arrive.
    private var totalSamples: UInt64 = 0
    /// Position of the oldest sample still in `held`.
    private var heldStartSample: UInt64 = 0

    public init(
        holdLimit: Duration = RelayAudioBridge.defaultHoldLimit,
        sampleRate: UInt32 = SonioxProtocol.sampleRate
    ) {
        self.sampleRate = UInt64(sampleRate)
        let seconds = holdLimit.components.seconds
        self.holdLimitSamples = UInt64(max(0, seconds)) * UInt64(sampleRate)
    }

    // MARK: audio thread

    /// Hand one chunk to the current leg, or to the hold buffer. Safe from the
    /// audio render thread: no allocation beyond the buffer append, no I/O.
    public func send(_ samples: [Int16]) {
        lock.lock()
        totalSamples += UInt64(samples.count)
        if let sink {
            lock.unlock()
            sink.enqueue(pcm: samples)
            return
        }
        if holding {
            held.append(samples)
            heldSamples += UInt64(samples.count)
            // Overflow drops the oldest chunk — and moves the front of the
            // buffer, so the offset the next leg gets still describes the
            // audio it will actually be fed.
            while heldSamples > holdLimitSamples, let first = held.first {
                held.removeFirst()
                heldSamples -= UInt64(first.count)
                heldStartSample += UInt64(first.count)
            }
        }
        lock.unlock()
    }

    // MARK: leg lifecycle

    /// Point the bridge at a leg with nothing held (the first connection).
    public func attach<Leg: PcmSink>(_ leg: Leg) {
        attach { _ in leg }
    }

    /// Create the next leg and hand it everything held during the gap.
    ///
    /// The closure receives the timestamp offset that leg must be configured
    /// with — the position of the oldest held sample, or the live position
    /// when nothing is held. Creating the client inside the closure is what
    /// makes offset, flush, and swap one atomic step: a chunk arriving from
    /// the audio thread mid-way can only land before the flush (held, and so
    /// flushed in order) or after the swap (sent straight to the new leg).
    /// Returning nil leaves the bridge holding.
    @discardableResult
    public func attach<Leg: PcmSink>(_ make: (UInt64) -> Leg?) -> Leg? {
        lock.lock()
        let offsetSamples = held.isEmpty ? totalSamples : heldStartSample
        let offsetMs = offsetSamples * 1000 / sampleRate
        guard let next = make(offsetMs) else {
            lock.unlock()
            return nil
        }
        let pending = held
        held = []
        heldSamples = 0
        heldStartSample = totalSamples
        holding = false
        sink = next
        lock.unlock()
        // Outside the lock: `enqueue` is non-blocking, but the audio thread
        // must never wait on a flush of up to 45 s of chunks.
        for chunk in pending {
            next.enqueue(pcm: chunk)
        }
        return next
    }

    /// The current leg is gone. Audio from here on is held until the next
    /// `attach` — or dropped by `discard()` when reconnecting is given up on.
    public func hold() {
        lock.lock()
        sink = nil
        holding = true
        heldStartSample = totalSamples - heldSamples
        lock.unlock()
    }

    /// Stop holding and drop what is held: no leg is coming. The bridge stays
    /// usable (and keeps counting) so the clock survives for a later attach.
    public func discard() {
        lock.lock()
        sink = nil
        holding = false
        held = []
        heldSamples = 0
        heldStartSample = totalSamples
        lock.unlock()
    }

    /// Forget everything, including the clock — a new recording.
    public func reset() {
        lock.lock()
        sink = nil
        holding = false
        held = []
        heldSamples = 0
        totalSamples = 0
        heldStartSample = 0
        lock.unlock()
    }

    // MARK: observation

    /// Position of the next sample to arrive, in milliseconds since `reset()`.
    public var capturedMilliseconds: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return totalSamples * 1000 / sampleRate
    }

    /// How much audio is currently held for the next leg.
    public var heldMilliseconds: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return heldSamples * 1000 / sampleRate
    }

    /// True while there is no leg and audio is being kept for the next one.
    public var isHolding: Bool {
        lock.lock()
        defer { lock.unlock() }
        return holding
    }
}
