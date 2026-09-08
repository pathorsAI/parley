import AVFoundation
import XCTest

@testable import ParleyKit

/// Import path checks: whatever the user picks must come out as the same
/// 16 kHz mono Ogg/Opus a live recording produces, with an honest duration and
/// no half-written file left behind when the source is not usable.
///
/// Fixtures are synthesised at runtime — a WAV written through AVAudioFile —
/// so the repository carries no binary blobs.
final class AudioFileDecoderTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AudioFileDecoderTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// Collects progress from the `@Sendable` callback without a data race.
    private final class ProgressLog: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Double] = []
        func record(_ v: Double) {
            lock.lock()
            values.append(v)
            lock.unlock()
        }
        var all: [Double] {
            lock.lock()
            defer { lock.unlock() }
            return values
        }
    }

    /// A sine-tone WAV; `seconds: 0` yields a header-only file with no frames.
    @discardableResult
    private func makeWAV(
        _ name: String, sampleRate: Double, channels: AVAudioChannelCount, seconds: Double
    ) throws -> URL {
        let url = dir.appendingPathComponent(name)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        guard seconds > 0 else { return url }
        let frames = AVAudioFrameCount(sampleRate * seconds)
        let buffer = try XCTUnwrap(
            AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        buffer.frameLength = frames
        let data = try XCTUnwrap(buffer.floatChannelData)
        for channel in 0..<Int(buffer.format.channelCount) {
            for i in 0..<Int(frames) {
                data[channel][i] = Float(
                    0.25 * sin(2 * .pi * 440 * Double(i) / sampleRate))
            }
        }
        try file.write(from: buffer)
        return url
    }

    private func destination(_ name: String = "out.ogg") -> URL {
        dir.appendingPathComponent(name)
    }

    func testStereo44kDecodesToOggOpus() throws {
        let source = try makeWAV("stereo.wav", sampleRate: 44_100, channels: 2, seconds: 1.5)
        let out = destination()

        let ms = try AudioFileDecoder.encodeToOggOpus(source: source, destination: out)

        // A 20 ms frame either way is fine; anything more means samples were lost.
        XCTAssertEqual(Double(ms), 1500, accuracy: 40)
        let data = try Data(contentsOf: out)
        XCTAssertGreaterThan(data.count, 500, "1.5s of 24kbps opus should be ~4KB+")
        XCTAssertEqual(String(data: data.prefix(4), encoding: .ascii), "OggS")
        XCTAssertNotNil(data.range(of: Data("OpusHead".utf8)))
    }

    func testCanonical16kMonoRoundTrips() throws {
        let source = try makeWAV("mono16k.wav", sampleRate: 16_000, channels: 1, seconds: 2.0)
        let out = destination()

        let ms = try AudioFileDecoder.encodeToOggOpus(source: source, destination: out)

        XCTAssertEqual(Double(ms), 2000, accuracy: 40)
        let data = try Data(contentsOf: out)
        XCTAssertEqual(String(data: data.prefix(4), encoding: .ascii), "OggS")
    }

    func testEmptySourceThrowsAndLeavesNoFile() throws {
        let source = try makeWAV("silent.wav", sampleRate: 44_100, channels: 1, seconds: 0)
        let out = destination()

        XCTAssertThrowsError(
            try AudioFileDecoder.encodeToOggOpus(source: source, destination: out)
        ) { error in
            XCTAssertEqual(error as? AudioFileDecoderError, .empty)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
    }

    func testNonAudioSourceThrowsUnreadableAndLeavesNoFile() throws {
        let source = dir.appendingPathComponent("not-really.m4a")
        try Data("this is not an audio file, whatever the extension claims".utf8)
            .write(to: source)
        let out = destination()

        XCTAssertThrowsError(
            try AudioFileDecoder.encodeToOggOpus(source: source, destination: out)
        ) { error in
            guard case .unreadable = error as? AudioFileDecoderError else {
                return XCTFail("expected .unreadable, got \(error)")
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
    }

    func testProgressIsMonotonicAndReachesOne() throws {
        // Long enough to need several converter turns at the 4 s chunk size.
        let source = try makeWAV("long.wav", sampleRate: 44_100, channels: 1, seconds: 9.0)
        let log = ProgressLog()

        _ = try AudioFileDecoder.encodeToOggOpus(
            source: source, destination: destination(), onProgress: { log.record($0) })

        let values = log.all
        XCTAssertFalse(values.isEmpty, "progress should be reported")
        XCTAssertEqual(values, values.sorted(), "progress must never go backwards")
        XCTAssertGreaterThanOrEqual(values.first ?? 1, 0)
        XCTAssertEqual(values.last ?? 0, 1.0, accuracy: 1e-9)
    }
}
