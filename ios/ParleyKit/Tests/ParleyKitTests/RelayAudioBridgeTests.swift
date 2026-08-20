import XCTest

@testable import ParleyKit

/// The contract a reconnect depends on: audio spoken while no socket exists is
/// held, bounded, delivered in order to the next leg, and timestamped so it
/// lands where it was actually said.
final class RelayAudioBridgeTests: XCTestCase {
    /// One second of audio at the pipeline's fixed 16 kHz.
    private static let secondOfSamples = Int(SonioxProtocol.sampleRate)

    private final class Recorder: PcmSink, @unchecked Sendable {
        private let lock = NSLock()
        private var chunks: [[Int16]] = []

        func enqueue(pcm samples: [Int16]) {
            lock.lock()
            chunks.append(samples)
            lock.unlock()
        }

        var received: [[Int16]] {
            lock.lock()
            defer { lock.unlock() }
            return chunks
        }

        var sampleCount: Int { received.reduce(0) { $0 + $1.count } }
    }

    /// A chunk whose every sample carries `marker`, so ordering is checkable.
    private func chunk(_ marker: Int16, samples: Int = 1_600) -> [Int16] {
        Array(repeating: marker, count: samples)
    }

    func testAttachedAudioGoesStraightToTheLeg() {
        let bridge = RelayAudioBridge()
        let leg = Recorder()
        bridge.attach(leg)

        bridge.send(chunk(1))
        bridge.send(chunk(2))

        XCTAssertEqual(leg.received.map { $0.first }, [1, 2])
        XCTAssertFalse(bridge.isHolding)
        XCTAssertEqual(bridge.heldMilliseconds, 0)
    }

    func testGapAudioIsHeldAndFlushedIntoTheNextLegInOrder() {
        let bridge = RelayAudioBridge()
        let first = Recorder()
        bridge.attach(first)
        bridge.send(chunk(1))

        bridge.hold()
        bridge.send(chunk(2))
        bridge.send(chunk(3))
        XCTAssertTrue(bridge.isHolding)
        XCTAssertEqual(bridge.heldMilliseconds, 200, "two 100 ms chunks are waiting")

        let second = Recorder()
        bridge.attach { _ in second }
        bridge.send(chunk(4))

        XCTAssertEqual(first.received.map { $0.first }, [1], "the dead leg gets nothing more")
        XCTAssertEqual(
            second.received.map { $0.first }, [2, 3, 4],
            "the gap arrives before the audio that followed it")
        XCTAssertEqual(bridge.heldMilliseconds, 0)
    }

    func testTheNextLegIsOffsetToWhereTheHeldAudioWasSpoken() {
        let bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        // Ten seconds of meeting before the socket dies.
        for _ in 0..<10 { bridge.send(chunk(1, samples: Self.secondOfSamples)) }

        bridge.hold()
        // Three seconds spoken into the gap.
        for _ in 0..<3 { bridge.send(chunk(2, samples: Self.secondOfSamples)) }

        var offset: UInt64?
        bridge.attach { ms in
            offset = ms
            return Recorder()
        }

        XCTAssertEqual(
            offset, 10_000,
            "the leg's clock starts at the first sample it is fed, not at the reconnect")
        XCTAssertEqual(bridge.capturedMilliseconds, 13_000)
    }

    func testOffsetWithNothingHeldIsTheLivePosition() {
        let bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        for _ in 0..<5 { bridge.send(chunk(1, samples: Self.secondOfSamples)) }
        bridge.hold()

        var offset: UInt64?
        bridge.attach { ms in
            offset = ms
            return Recorder()
        }
        XCTAssertEqual(offset, 5_000)
    }

    func testHoldingIsBoundedAndDropsTheOldestAudio() {
        let bridge = RelayAudioBridge(holdLimit: .seconds(3))
        bridge.attach(Recorder())
        bridge.hold()

        // Six seconds into a three-second buffer.
        for marker in 1...6 { bridge.send(chunk(Int16(marker), samples: Self.secondOfSamples)) }
        XCTAssertEqual(bridge.heldMilliseconds, 3_000, "the hold never grows past its bound")

        let leg = Recorder()
        var offset: UInt64?
        bridge.attach { ms in
            offset = ms
            return leg
        }

        XCTAssertEqual(
            leg.received.map { $0.first }, [4, 5, 6], "the oldest seconds were dropped, not the newest")
        XCTAssertEqual(
            offset, 3_000,
            "the offset follows the front of the buffer, so the surviving audio still lands where it was said"
        )
    }

    func testDiscardDropsHeldAudioAndKeepsTheClock() {
        let bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        bridge.send(chunk(1, samples: Self.secondOfSamples))
        bridge.hold()
        bridge.send(chunk(2, samples: Self.secondOfSamples))

        bridge.discard()
        XCTAssertFalse(bridge.isHolding)
        XCTAssertEqual(bridge.heldMilliseconds, 0)

        // Audio after giving up is dropped on the floor rather than piling up.
        bridge.send(chunk(3, samples: Self.secondOfSamples))
        XCTAssertEqual(bridge.heldMilliseconds, 0)
        XCTAssertEqual(bridge.capturedMilliseconds, 3_000)

        let leg = Recorder()
        var offset: UInt64?
        bridge.attach { ms in
            offset = ms
            return leg
        }
        XCTAssertEqual(offset, 3_000, "a later leg still knows how far into the recording it is")
        XCTAssertEqual(leg.sampleCount, 0)
    }

    func testAttachReturningNilLeavesTheBridgeHolding() {
        let bridge = RelayAudioBridge()
        bridge.hold()
        bridge.send(chunk(1))

        let leg: Recorder? = bridge.attach { _ -> Recorder? in nil }
        XCTAssertNil(leg)
        XCTAssertTrue(bridge.isHolding)
        XCTAssertEqual(bridge.heldMilliseconds, 100, "nothing was flushed, so nothing was lost")
    }

    func testResetForgetsTheClock() {
        let bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        bridge.send(chunk(1, samples: Self.secondOfSamples))
        bridge.reset()

        XCTAssertEqual(bridge.capturedMilliseconds, 0)
        XCTAssertFalse(bridge.isHolding)
    }

    /// A leg that dies while the microphone is mid-chunk must not lose or
    /// reorder audio: everything sent lands somewhere, exactly once, in order.
    func testConcurrentSendsAcrossAReconnectLoseNothing() {
        let bridge = RelayAudioBridge()
        let first = Recorder()
        let second = Recorder()
        bridge.attach(first)

        let chunks = 200
        let sender = DispatchQueue(label: "audio-thread")
        let done = expectation(description: "audio sent")
        sender.async {
            for i in 0..<chunks {
                bridge.send([Int16(i)])
            }
            done.fulfill()
        }
        // Swap the leg out and in from under the sender.
        bridge.hold()
        bridge.attach { _ in second }
        wait(for: [done], timeout: 5)

        let delivered = (first.received + second.received).map { $0[0] }
        XCTAssertEqual(delivered.count, chunks, "every chunk reached a leg exactly once")
        XCTAssertEqual(delivered, delivered.sorted(), "and none of them overtook another")
    }
}
