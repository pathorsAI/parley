import XCTest

@testable import ParleyKit

/// Not a test — the last step of `ios/AppStore/make-demo-audio.sh`.
///
/// The screenshot demo's audio has to be encoded by `OggOpusEncoder`, so that
/// what plays in the simulator is the same kind of file a phone records rather
/// than ffmpeg's idea of Ogg/Opus. That encoder lives in this package and has no
/// executable to call it from, so the generator borrows the test runner.
///
/// Skipped unless the script sets the two environment variables, which is why it
/// costs a normal `swift test` nothing.
final class DemoAudioFixtureTests: XCTestCase {
    func testWriteDemoAudio() throws {
        let environment = ProcessInfo.processInfo.environment
        let source = try XCTSkipIfNil(environment["PARLEY_DEMO_AUDIO_IN"])
        let destination = try XCTSkipIfNil(environment["PARLEY_DEMO_AUDIO_OUT"])

        let out = URL(fileURLWithPath: destination)
        try? FileManager.default.removeItem(at: out)
        let ms = try AudioFileDecoder.encodeToOggOpus(
            source: URL(fileURLWithPath: source), destination: out)

        print("wrote \(out.lastPathComponent): \(ms) ms")
        // Round-trips through the same reader the player uses, so a broken
        // fixture fails here rather than as a blank waveform in a screenshot.
        let overview = try AudioPeaks.compute(url: out)
        XCTAssertEqual(overview.seconds * 1000, Double(ms), accuracy: 200)
        XCTAssertGreaterThan(overview.peaks.max() ?? 0, 0.01, "fixture should contain speech")
    }

    private func XCTSkipIfNil(_ value: String?) throws -> String {
        guard let value, !value.isEmpty else {
            throw XCTSkip("set PARLEY_DEMO_AUDIO_IN and PARLEY_DEMO_AUDIO_OUT to regenerate")
        }
        return value
    }
}
