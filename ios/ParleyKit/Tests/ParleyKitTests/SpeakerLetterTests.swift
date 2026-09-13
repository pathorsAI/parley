import XCTest

@testable import ParleyKit

/// Speakers are named by letter — 「講者 A」/ "Speaker A" — so the mapping from a
/// diarization index to a letter is the contract two screens and the clipboard
/// all read through. These are the boundaries worth pinning: the first wrap, the
/// second wrap, and the index that is not a speaker at all.
final class SpeakerLetterTests: XCTestCase {
    func testFirstTwentySixAreSingleLetters() {
        XCTAssertEqual(speakerLetter(1), "A")
        XCTAssertEqual(speakerLetter(2), "B")
        XCTAssertEqual(speakerLetter(3), "C")
        XCTAssertEqual(speakerLetter(25), "Y")
        XCTAssertEqual(speakerLetter(26), "Z")
    }

    /// Bijective base-26, not plain base-26: 27 is AA, and there is no such
    /// thing as a leading "A0".
    func testWrapsToTwoLetters() {
        XCTAssertEqual(speakerLetter(27), "AA")
        XCTAssertEqual(speakerLetter(28), "AB")
        XCTAssertEqual(speakerLetter(52), "AZ")
        XCTAssertEqual(speakerLetter(53), "BA")
        XCTAssertEqual(speakerLetter(702), "ZZ")
        XCTAssertEqual(speakerLetter(703), "AAA")
    }

    /// 0 means the provider has not decided who is talking. That is not speaker
    /// A, and naming it so would invent a person — the callers render the empty
    /// string as an ellipsis.
    func testNonSpeakerIndicesAreEmpty() {
        XCTAssertEqual(speakerLetter(0), "")
        XCTAssertEqual(speakerLetter(-1), "")
    }

    func testEveryIndexUpToATousandIsUniqueAndAlphabetic() {
        var seen = Set<String>()
        for n in 1...1_000 {
            let letters = speakerLetter(n)
            XCTAssertFalse(letters.isEmpty, "speaker \(n) got no letter")
            XCTAssertTrue(
                letters.allSatisfy { $0.isUppercase && $0.isASCII },
                "speaker \(n) got \(letters)")
            XCTAssertTrue(seen.insert(letters).inserted, "\(letters) handed out twice")
        }
    }

    /// The one thing the app actually renders: a `mix` segment with no assigned
    /// name comes back as the letter form, and an undecided one as the ellipsis.
    func testSpeakerLabelUsesLetters() {
        func label(speaker: Int, names: [String: String] = [:]) -> String {
            RecordingMeta.speakerLabel(
                for: TranscriptSegment(
                    id: "mix-0", source: "mix", speaker: speaker, text: "hi",
                    isFinal: true, startMs: 0, endMs: 1),
                names: names)
        }

        XCTAssertTrue(label(speaker: 1).hasSuffix("A"), label(speaker: 1))
        XCTAssertTrue(label(speaker: 2).hasSuffix("B"), label(speaker: 2))
        XCTAssertEqual(label(speaker: 0), "…")
        // A name always wins over the letter.
        XCTAssertEqual(label(speaker: 1, names: ["mix-1": "Anna"]), "Anna")
    }
}
