import AVFoundation
import AudioToolbox
import XCTest

@testable import ParleyKit

/// The test that would have caught #375.
///
/// Every playback check before this one asked the player where it was and
/// believed the answer. `AVAudioPlayer` answers that question correctly and
/// plays something else entirely, so all of them passed while the shipped app
/// ignored the scrubber. The only honest question is "what samples come out",
/// and the only way to ask it in a unit test is to render them: the engine runs
/// in `AVAudioEngine`'s manual rendering mode, and the audio it produces after a
/// seek is compared — in dB — against what `ExtAudioFile` reads straight off the
/// file at the same timestamp.
///
/// The fixture is `demo-renewal.ogg`, the screenshot demo's recording: 105
/// seconds of scripted dialogue written by `OggOpusEncoder`, with deliberate
/// gaps between the turns. It starts in one of those gaps, which is what makes
/// "did the seek move the audio" answerable by loudness alone.
final class OggPlaybackEngineTests: XCTestCase {

    /// A loud moment, and a quiet one. Both are ground-truthed from the file in
    /// every test rather than hard-coded, so re-generating the fixture changes
    /// the numbers and not the assertions.
    private static let loudTime: TimeInterval = 46
    private static let quietTime: TimeInterval = 0

    private var url: URL!

    override func setUpWithError() throws {
        url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "demo-renewal", withExtension: "ogg", subdirectory: "Resources"),
            "the demo recording is missing from the test bundle")
    }

    // MARK: the bug

    /// Seek to a loud moment, render a second, and check that what came out is
    /// that moment rather than the file's quiet opening.
    ///
    /// This is the assertion the old player fails. The fixture is digital
    /// silence for its first eleven seconds and −17.9 dB at 46 s, so
    /// `AVAudioPlayer` — which would still be decoding the silence at the head
    /// while reporting `currentTime == 46` — comes out ninety-odd dB short.
    func testSeekChangesTheAudioNotJustTheClock() throws {
        let quietTruth = try Self.truthRMS(url: url, from: Self.quietTime, seconds: 1)
        let loudTruth = try Self.truthRMS(url: url, from: Self.loudTime, seconds: 1)
        XCTAssertGreaterThan(
            Self.dB(loudTruth) - Self.dB(quietTruth), 30,
            "fixture no longer has a quiet head and a loud \(Self.loudTime) s mark")

        let engine = try Self.offlineEngine(url: url)
        engine.seek(to: Self.loudTime)
        try engine.play()
        let rendered = try engine.rms(seconds: 1)

        XCTAssertEqual(
            Self.dB(rendered), Self.dB(loudTruth), accuracy: 3,
            "rendered \(Self.dB(rendered)) dB, file holds \(Self.dB(loudTruth)) dB at "
                + "\(Self.loudTime) s")
        XCTAssertGreaterThan(
            Self.dB(rendered) - Self.dB(quietTruth), 30,
            "rendered the head of the file instead of \(Self.loudTime) s — this is #375")
    }

    /// Seeking back to 0 renders the head again: the decoder rewinds, it does
    /// not merely fail to move.
    func testSeekBackToTheHead() throws {
        let quietTruth = try Self.truthRMS(url: url, from: Self.quietTime, seconds: 1)

        let engine = try Self.offlineEngine(url: url)
        engine.seek(to: Self.loudTime)
        try engine.play()
        _ = try engine.rms(seconds: 1)

        engine.seek(to: 0)
        let rendered = try engine.rms(seconds: 1)
        XCTAssertEqual(Self.dB(rendered), Self.dB(quietTruth), accuracy: 3)
    }

    /// A seek *during* playback — the scrubber's actual case — lands on the
    /// target rather than carrying on from where it was.
    func testSeekWhilePlaying() throws {
        let loudTruth = try Self.truthRMS(url: url, from: Self.loudTime, seconds: 0.5)

        let engine = try Self.offlineEngine(url: url)
        try engine.play()
        _ = try engine.rms(seconds: 0.5)  // playing from the top
        engine.seek(to: Self.loudTime)
        let rendered = try engine.rms(seconds: 0.5)

        XCTAssertEqual(Self.dB(rendered), Self.dB(loudTruth), accuracy: 3)
    }

    /// The clock follows the audio, and keeps following it while rendering.
    func testCurrentTimeTracksTheSeek() throws {
        let engine = try Self.offlineEngine(url: url)
        engine.seek(to: 30)
        XCTAssertEqual(engine.currentTime, 30, accuracy: 0.01, "the clock has to move at once")
        try engine.play()
        _ = try engine.rms(seconds: 1)
        XCTAssertEqual(engine.currentTime, 31, accuracy: 0.2)
    }

    // MARK: duration

    /// `kExtAudioFileProperty_FileLengthFrames` is in 48 kHz Opus granules. Read
    /// it against the 16 kHz client rate instead and a 105-second recording
    /// reports as 315 seconds, so this is cross-checked against the only other
    /// thing that gets it right.
    func testDurationMatchesAVAudioPlayer() throws {
        let engine = try OggPlaybackEngine(url: url)
        let reference = try AVAudioPlayer(contentsOf: url).duration
        XCTAssertEqual(engine.duration, reference, accuracy: 0.2)
        XCTAssertEqual(engine.duration, 105.0, accuracy: 0.5)
    }

    // MARK: the end of the file

    /// The last buffer's `.dataPlayedBack` completion is what replaces
    /// `audioPlayerDidFinishPlaying`. Seek to just before the end, render past
    /// it, and it has to fire exactly once with the clock parked at the end.
    func testFinishFiresAtTheEnd() throws {
        let engine = try Self.offlineEngine(url: url)
        let finished = expectation(description: "onFinish")
        finished.assertForOverFulfill = true
        engine.onFinish = { finished.fulfill() }

        engine.seek(to: engine.duration - 1)
        try engine.play()
        _ = try engine.rms(seconds: 2)

        wait(for: [finished], timeout: 5)
        XCTAssertEqual(engine.currentTime, engine.duration, accuracy: 0.05)
    }

    // MARK: rate

    /// Time pitch replaces `enableRate`, so 2× has to consume the file twice as
    /// fast — the clock is the cheap way to see that from a render loop.
    func testDoubleRateAdvancesTheClockTwiceAsFast() throws {
        let engine = try Self.offlineEngine(url: url)
        engine.rate = 2
        try engine.play()
        _ = try engine.rms(seconds: 1)
        XCTAssertEqual(engine.currentTime, 2, accuracy: 0.3)
    }

    // MARK: helpers

    private static func offlineEngine(url: URL) throws -> OggPlaybackEngine {
        try OggPlaybackEngine(url: url, output: .offline(maximumFrameCount: 4_096))
    }

    static func dB(_ rms: Double) -> Double {
        20 * log10(max(rms, 1e-9))
    }

    /// What is actually in the file between `from` and `from + seconds`, read
    /// the same way `AudioPeaks` reads it — `ExtAudioFile`, Float32 mono
    /// 16 kHz, positioned with `ExtAudioFileSeek`.
    ///
    /// The seek offset is in the **file's** 48 kHz frames even though every
    /// frame read back is a 16 kHz client frame. Getting that wrong here would
    /// be invisible rather than red: the ground truth and the engine would be
    /// wrong by the same factor of three and agree perfectly about the wrong
    /// second.
    static func truthRMS(url: URL, from: TimeInterval, seconds: TimeInterval) throws -> Double {
        var ref: ExtAudioFileRef?
        guard ExtAudioFileOpenURL(url as CFURL, &ref) == noErr, let file = ref else {
            throw OggPlaybackError.unreadable("open")
        }
        defer { ExtAudioFileDispose(file) }

        let rate = OggPlaybackEngine.sampleRate
        var client = AudioStreamBasicDescription(
            mSampleRate: rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        guard
            ExtAudioFileSetProperty(
                file, kExtAudioFileProperty_ClientDataFormat,
                UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client) == noErr
        else { throw OggPlaybackError.unreadable("client format") }
        var fileFormat = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard
            ExtAudioFileGetProperty(
                file, kExtAudioFileProperty_FileDataFormat, &formatSize, &fileFormat) == noErr,
            fileFormat.mSampleRate > 0
        else { throw OggPlaybackError.unreadable("file format") }
        ExtAudioFileSeek(file, Int64((from * fileFormat.mSampleRate).rounded()))

        let wanted = Int((seconds * rate).rounded())
        var scratch = [Float](repeating: 0, count: 4_096)
        var sum = 0.0
        var read = 0
        while read < wanted {
            var count = UInt32(min(scratch.count, wanted - read))
            let status = scratch.withUnsafeMutableBytes { raw -> OSStatus in
                var list = AudioBufferList(
                    mNumberBuffers: 1,
                    mBuffers: AudioBuffer(
                        mNumberChannels: 1, mDataByteSize: UInt32(raw.count),
                        mData: raw.baseAddress))
                return ExtAudioFileRead(file, &count, &list)
            }
            guard status == noErr, count > 0 else { break }
            for index in 0..<Int(count) { sum += Double(scratch[index]) * Double(scratch[index]) }
            read += Int(count)
        }
        guard read > 0 else { throw OggPlaybackError.empty }
        return (sum / Double(read)).squareRoot()
    }
}

extension OggPlaybackEngine {
    /// Render `seconds` offline and reduce it to one RMS value.
    fileprivate func rms(seconds: Double) throws -> Double {
        let buffer = try renderOffline(seconds: seconds)
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum = 0.0
        for index in 0..<Int(buffer.frameLength) {
            sum += Double(channel[index]) * Double(channel[index])
        }
        return (sum / Double(buffer.frameLength)).squareRoot()
    }
}
