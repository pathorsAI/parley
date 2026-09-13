import AVFoundation
import XCTest

@testable import ParleyKit

/// The overview waveform's numbers, and the decode path they come off.
///
/// Two separate claims are under test here and they fail for different reasons:
///
/// 1. **The decode path.** `AVAudioPlayer` and `ExtAudioFile` can both open the
///    Ogg/Opus `OggOpusEncoder` writes, and report the right duration. This is
///    the load-bearing assumption of the whole player — if it ever stops being
///    true, the app needs a hand-written Ogg demuxer and a CAF transcode, and
///    this is the test that says so out loud rather than the player silently
///    showing "Preparing…" for ever.
/// 2. **The arithmetic.** Loud audio measures louder than quiet audio, silence
///    measures as silence, the bucket count is exact whatever the length, and a
///    cache round-trips.
///
/// Fixtures are synthesised — the repository carries no audio blobs.
final class AudioPeaksTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AudioPeaksTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// A 16 kHz mono Ogg/Opus whose amplitude is `amplitude(t)` — written the
    /// long way round (WAV, then the real encoder) so the bytes under test are
    /// the bytes a recording produces.
    private func makeOgg(
        _ name: String, seconds: Double, amplitude: (Double) -> Double
    ) throws -> URL {
        let wav = dir.appendingPathComponent("\(name).wav")
        // Scoped so the file is closed and flushed before anything reads it: an
        // AVAudioFile still alive has written nothing the reader can see.
        try {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: Double(OggOpusEncoder.sampleRate),
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            let file = try AVAudioFile(forWriting: wav, settings: settings)
            let frames = AVAudioFrameCount(Double(OggOpusEncoder.sampleRate) * seconds)
            let buffer = try XCTUnwrap(
                AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
            buffer.frameLength = frames
            let channel = try XCTUnwrap(buffer.floatChannelData)
            for index in 0..<Int(frames) {
                let t = Double(index) / Double(OggOpusEncoder.sampleRate)
                channel[0][index] = Float(amplitude(t) * sin(2 * .pi * 330 * t))
            }
            try file.write(from: buffer)
        }()

        let ogg = dir.appendingPathComponent("\(name).ogg")
        try? FileManager.default.removeItem(at: ogg)
        _ = try AudioFileDecoder.encodeToOggOpus(source: wav, destination: ogg)
        return ogg
    }

    // MARK: the decode path

    /// Path 1 of the player's decode ladder: AVFoundation opens the Ogg itself.
    func testAVAudioPlayerOpensTheOggAndReportsTheDuration() throws {
        let ogg = try makeOgg("player", seconds: 4.0) { _ in 0.3 }

        let player = try AVAudioPlayer(contentsOf: ogg)

        XCTAssertEqual(player.duration, 4.0, accuracy: 0.15)
        // Rate control has to survive the same open, or speed is a lie.
        player.enableRate = true
        player.rate = 1.5
        XCTAssertEqual(player.rate, 1.5, accuracy: 0.001)
    }

    /// The same path, from the PCM side. `ExtAudioFile` is what `compute` uses,
    /// and it reaches the end of an Ogg despite the container declaring no
    /// length — see the note in `AudioPeaks`.
    func testComputeReachesTheEndOfAnOggThatDeclaresNoLength() throws {
        let ogg = try makeOgg("length", seconds: 6.0) { _ in 0.3 }

        let overview = try AudioPeaks.compute(url: ogg)

        XCTAssertEqual(overview.seconds, 6.0, accuracy: 0.1)
        XCTAssertEqual(overview.peaks.count, AudioPeaks.bucketCount)
    }

    // MARK: the arithmetic

    func testQuietAndLoudHalvesAreTellableApart() throws {
        // Loud for the first half, near-silent for the second.
        let ogg = try makeOgg("halves", seconds: 8.0) { t in t < 4 ? 0.6 : 0.01 }

        let overview = try AudioPeaks.compute(url: ogg)

        let count = overview.peaks.count
        // The middle tenth is skipped: Opus smears the transition across a frame
        // or two and the point is the halves, not the seam.
        let loud = overview.peaks[0..<(count * 45 / 100)]
        let quiet = overview.peaks[(count * 55 / 100)...]
        let loudMean = loud.reduce(0, +) / Float(loud.count)
        let quietMean = quiet.reduce(0, +) / Float(quiet.count)
        XCTAssertGreaterThan(loudMean, 0.15, "0.6 amplitude should measure well off the floor")
        XCTAssertLessThan(quietMean, 0.05, "0.01 amplitude should measure near silence")
        XCTAssertGreaterThan(loudMean, quietMean * 4)
    }

    func testSilenceMeasuresAsSilenceWithoutBeingEmpty() throws {
        let ogg = try makeOgg("silence", seconds: 3.0) { _ in 0 }

        let overview = try AudioPeaks.compute(url: ogg)

        XCTAssertEqual(overview.peaks.count, AudioPeaks.bucketCount)
        XCTAssertEqual(overview.peaks.max() ?? 1, 0, accuracy: 0.01)
    }

    /// A clip shorter than the bucket count still fills every bucket — the
    /// drawing asks for a fixed number of bars and must not be handed fewer.
    func testShortClipStillFillsEveryBucket() throws {
        let ogg = try makeOgg("short", seconds: 0.5) { _ in 0.4 }

        let overview = try AudioPeaks.compute(url: ogg)

        XCTAssertEqual(overview.peaks.count, AudioPeaks.bucketCount)
        XCTAssertGreaterThan(overview.peaks.max() ?? 0, 0.1)
    }

    func testUnreadableFileThrows() throws {
        let junk = dir.appendingPathComponent("not-audio.ogg")
        try Data("OggS is only the first four bytes of a promise".utf8).write(to: junk)

        XCTAssertThrowsError(try AudioPeaks.compute(url: junk)) { error in
            guard case .unreadable = error as? AudioPeaksError else {
                return XCTFail("expected .unreadable, got \(error)")
            }
        }
    }

    func testProgressIsMonotonicAndEndsAtOne() throws {
        let ogg = try makeOgg("progress", seconds: 12.0) { _ in 0.3 }
        let log = Recorder()

        _ = try AudioPeaks.compute(
            url: ogg, expectedSeconds: 12.0, onProgress: { log.record($0) })

        let values = log.all
        XCTAssertFalse(values.isEmpty, "progress should be reported")
        XCTAssertEqual(values, values.sorted(), "progress must never go backwards")
        XCTAssertEqual(values.last ?? 0, 1.0, accuracy: 1e-9)
    }

    func testCancellationStops() throws {
        let ogg = try makeOgg("cancel", seconds: 4.0) { _ in 0.3 }

        XCTAssertThrowsError(
            try AudioPeaks.compute(url: ogg, isCancelled: { true })
        ) { error in
            XCTAssertEqual(error as? AudioPeaksError, .cancelled)
        }
    }

    // MARK: resampling

    func testResampleHitsTheRequestedCountBothWays() {
        XCTAssertEqual(AudioPeaks.resample(Array(repeating: 0.5, count: 1_000), to: 400).count, 400)
        XCTAssertEqual(AudioPeaks.resample(Array(repeating: 0.5, count: 7), to: 130).count, 130)
        XCTAssertEqual(AudioPeaks.resample([], to: 130), Array(repeating: 0, count: 130))
        XCTAssertEqual(AudioPeaks.resample([0.5], to: 0), [])
    }

    /// Downsampling is energy-preserving, not maximum-preserving: a single spike
    /// in a quiet stretch must not turn the whole bar into a full-height one.
    func testDownsamplingAveragesEnergyRatherThanTakingTheMaximum() {
        var values = [Float](repeating: 0, count: 100)
        values[50] = 1.0

        let reduced = AudioPeaks.resample(values, to: 1)

        XCTAssertEqual(reduced.count, 1)
        XCTAssertEqual(reduced[0], 0.1, accuracy: 0.001, "sqrt(1/100), not 1.0")
    }

    func testResampleKeepsTheShapeOfTwoHalves() {
        let values = Array(repeating: Float(0.8), count: 50) + Array(repeating: Float(0.1), count: 50)

        let reduced = AudioPeaks.resample(values, to: 4)

        XCTAssertEqual(reduced.count, 4)
        XCTAssertGreaterThan(reduced[0], reduced[3])
        XCTAssertEqual(reduced[0], 0.8, accuracy: 0.001)
        XCTAssertEqual(reduced[3], 0.1, accuracy: 0.001)
    }

    // MARK: the cache file

    func testCacheRoundTrips() throws {
        let overview = AudioPeaks.Overview(
            peaks: (0..<AudioPeaks.bucketCount).map { Float($0) / Float(AudioPeaks.bucketCount) },
            seconds: 1_122.5)

        let data = AudioPeaks.encode(overview)
        let back = try AudioPeaks.decode(data)

        XCTAssertEqual(data.count, 16 + AudioPeaks.bucketCount * 4, "16-byte header, 4B per bucket")
        XCTAssertEqual(back.peaks, overview.peaks)
        XCTAssertEqual(back.seconds, overview.seconds, accuracy: 0.001)
    }

    func testDecodeRejectsGarbage() {
        for (name, data) in [
            ("empty", Data()),
            ("short", Data([0x50, 0x4B, 0x57, 0x31])),
            ("wrong magic", AudioPeaks.encode(.init(peaks: [0.1], seconds: 1)).replacingFirstByte()),
            (
                "truncated payload",
                AudioPeaks.encode(.init(peaks: [0.1, 0.2, 0.3], seconds: 1)).dropLast(4)
            ),
        ] {
            XCTAssertThrowsError(try AudioPeaks.decode(Data(data)), name) { error in
                XCTAssertEqual(error as? AudioPeaksError, .corruptCache, name)
            }
        }
    }

    /// The store keeps the waveform beside the audio and throws both away
    /// together — a stale cache drawn over the next file would be worse than no
    /// cache at all.
    func testStoreKeepsPeaksWithTheAudioAndRemovesThemWithIt() throws {
        let store = LocalAudioStore(base: dir)
        let scratch = dir.appendingPathComponent("incoming.ogg")
        try Data("pretend this is an ogg".utf8).write(to: scratch)
        try store.put("r1", from: scratch)
        let overview = AudioPeaks.Overview(peaks: [0.1, 0.2, 0.3], seconds: 7)

        store.putPeaks(overview, for: "r1")

        XCTAssertEqual(store.peaks(for: "r1")?.peaks, overview.peaks)
        XCTAssertEqual(store.peaksURL(for: "r1").deletingLastPathComponent(),
                       store.url(for: "r1").deletingLastPathComponent())

        store.remove("r1")
        XCTAssertFalse(store.has("r1"))
        XCTAssertNil(store.peaks(for: "r1"))
    }

    func testCorruptCacheReadsAsNoCache() throws {
        let store = LocalAudioStore(base: dir)
        store.putPeaks(.init(peaks: [0.1], seconds: 1), for: "r2")
        try Data("not peaks".utf8).write(to: store.peaksURL(for: "r2"))

        XCTAssertNil(store.peaks(for: "r2"))
    }

    /// Collects `@Sendable` progress callbacks without a data race.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Double] = []
        func record(_ value: Double) {
            lock.lock()
            values.append(value)
            lock.unlock()
        }
        var all: [Double] {
            lock.lock()
            defer { lock.unlock() }
            return values
        }
    }
}

extension Data {
    /// A cache file with the magic word broken.
    fileprivate func replacingFirstByte() -> Data {
        var copy = self
        copy[copy.startIndex] = 0xFF
        return copy
    }
}
