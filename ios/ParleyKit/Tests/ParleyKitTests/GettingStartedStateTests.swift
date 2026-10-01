import XCTest

@testable import ParleyKit

final class GettingStartedStateTests: XCTestCase {

    // MARK: marking

    func testAFreshListHasNothingDoneAndIsVisible() {
        let state = GettingStartedState()

        XCTAssertEqual(state.done, 0)
        XCTAssertEqual(state.progress, 0)
        XCTAssertTrue(state.isVisible)
    }

    func testMarkingIsIdempotent() {
        var state = GettingStartedState()

        XCTAssertTrue(state.mark(.recorded))
        XCTAssertFalse(state.mark(.recorded))
        XCTAssertEqual(state.done, 1)
        XCTAssertTrue(state.recorded)
    }

    func testEachStepFlipsItsOwnFlag() {
        for step in GettingStartedStep.allCases {
            var state = GettingStartedState()
            state.mark(step)
            XCTAssertTrue(state[step])
            XCTAssertEqual(
                GettingStartedStep.allCases.filter { state[$0] }, [step],
                "\(step) touched another flag")
        }
    }

    func testProgressCountsOutOfFour() {
        var state = GettingStartedState()
        state.mark(.recorded)
        state.mark(.replayed)

        XCTAssertEqual(GettingStartedState.total, 4)
        XCTAssertEqual(state.done, 2)
        XCTAssertEqual(state.progress, 0.5)
    }

    // MARK: visibility

    func testFinishingAllFourHidesTheList() {
        var state = GettingStartedState()
        for step in GettingStartedStep.allCases { state.mark(step) }

        XCTAssertTrue(state.isComplete)
        XCTAssertFalse(state.isVisible)
    }

    func testDismissingHidesTheListWithWorkLeft() {
        var state = GettingStartedState()
        state.mark(.recorded)
        state.dismiss(at: Date(timeIntervalSince1970: 1))

        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(state.dismissedAt, Date(timeIntervalSince1970: 1))
    }

    func testResetIsAFreshState() {
        var state = GettingStartedState(recorded: true, filed: true, dismissedAt: Date())
        state = GettingStartedState()

        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(state.done, 0)
    }

    // MARK: in the library

    func testAVisibleListWaitsForTheLoadWhileTheExistingUserCheckIsPending() {
        let state = GettingStartedState()

        XCTAssertFalse(
            state.showsInLibrary(
                libraryLoaded: false, existingUserChecked: false, libraryIsEmpty: true))
        XCTAssertTrue(
            state.showsInLibrary(
                libraryLoaded: true, existingUserChecked: false, libraryIsEmpty: false))
    }

    /// The reset-from-Settings case: the list is back, and it must be on screen
    /// before the library has finished reloading from the cloud.
    func testAVisibleListShowsBeforeTheLoadOnceTheCheckHasRun() {
        XCTAssertTrue(
            GettingStartedState().showsInLibrary(
                libraryLoaded: false, existingUserChecked: true, libraryIsEmpty: true))
    }

    func testAVisibleListShowsWhateverTheRecordingCount() {
        for empty in [true, false] {
            XCTAssertTrue(
                GettingStartedState().showsInLibrary(
                    libraryLoaded: true, existingUserChecked: true, libraryIsEmpty: empty))
        }
    }

    func testAFinishedListComesBackOnlyForALoadedEmptyLibrary() {
        var state = GettingStartedState()
        for step in GettingStartedStep.allCases { state.mark(step) }

        XCTAssertTrue(
            state.showsInLibrary(libraryLoaded: true, existingUserChecked: true, libraryIsEmpty: true))
        XCTAssertFalse(
            state.showsInLibrary(
                libraryLoaded: false, existingUserChecked: true, libraryIsEmpty: true),
            "an empty library before the load is not known to be empty")
        XCTAssertFalse(
            state.showsInLibrary(
                libraryLoaded: true, existingUserChecked: true, libraryIsEmpty: false))
    }

    func testADismissedListStaysClosed() {
        var state = GettingStartedState()
        state.dismiss()

        XCTAssertFalse(
            state.showsInLibrary(libraryLoaded: true, existingUserChecked: true, libraryIsEmpty: true))
    }

    // MARK: existing users

    func testASessionFromAnEarlierBuildStartsDismissed() {
        let now = Date(timeIntervalSince1970: 42)
        let state = GettingStartedState.initial(hadStoredSession: true, now: now)

        XCTAssertEqual(state.dismissedAt, now)
        XCTAssertFalse(state.isVisible)
    }

    func testAFreshInstallStartsVisible() {
        let state = GettingStartedState.initial(hadStoredSession: false)

        XCTAssertNil(state.dismissedAt)
        XCTAssertTrue(state.isVisible)
    }

    func testALibraryFullOfRecordingsMadeElsewhereDismisses() {
        XCTAssertTrue(GettingStartedState().shouldDismissForExistingLibrary(recordingCount: 3))
    }

    func testAnEmptyLibraryKeepsTheList() {
        XCTAssertFalse(GettingStartedState().shouldDismissForExistingLibrary(recordingCount: 0))
    }

    /// A new user whose first recording is what put something in the library
    /// has already ticked `recorded` — that is their first lap, not history.
    func testALibraryThisUserJustStartedKeepsTheList() {
        var state = GettingStartedState()
        state.mark(.recorded)

        XCTAssertFalse(state.shouldDismissForExistingLibrary(recordingCount: 1))
    }

    // MARK: persistence

    func testRoundTripsThroughJSON() throws {
        var state = GettingStartedState()
        state.mark(.filed)
        state.dismiss(at: Date(timeIntervalSince1970: 1_000))

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(GettingStartedState.self, from: data)

        XCTAssertEqual(decoded, state)
    }
}

final class SampleManifestTests: XCTestCase {

    private let json = """
        {
          "id": "sample-hongsheng-en-v1",
          "lang": "en",
          "title": "Sample: first call",
          "audio": "sample-en.ogg",
          "durationMs": 20000,
          "meetingKind": "sales",
          "context": "First discovery call.",
          "speakers": { "me": "You", "them": "Mr. Lin" },
          "voices": { "me": "Samantha", "them": "Daniel" },
          "segments": [
            { "speaker": "me", "startMs": 300, "endMs": 7015, "text": "Good afternoon." },
            { "speaker": "them", "startMs": 7665, "endMs": 18608, "text": "Afternoon." }
          ],
          "questions": ["What was the price objection?"],
          "mcpQuestions": ["Find the call."]
        }
        """

    func testDecodesAndIgnoresFieldsThePhoneDoesNotUse() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))

        XCTAssertEqual(manifest.id, "sample-hongsheng-en-v1")
        XCTAssertEqual(manifest.speakers.them, "Mr. Lin")
        XCTAssertEqual(manifest.segments.count, 2)
        XCTAssertEqual(manifest.questions, ["What was the price objection?"])
        XCTAssertTrue(SampleManifest.isSample(id: manifest.id))
        XCTAssertFalse(SampleManifest.isSample(id: "rec-1"))
    }

    func testTheMetaReadsLikeASyncedRecording() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        let meta = manifest.meta(createdAt: 1_000, folderId: "f-1")

        XCTAssertEqual(meta.id, manifest.id)
        XCTAssertEqual(meta.folderId, "f-1")
        XCTAssertEqual(meta.meetingContext, "First discovery call.")
        let segments = meta.segments
        XCTAssertEqual(segments.map(\.startMs), [300, 7665])
        XCTAssertEqual(segments.map { meta.speakerLabel(for: $0) }, ["You", "Mr. Lin"])
        XCTAssertEqual(Set(segments.map(\.speaker)).count, 2, "the detail screen counts by index")
    }

    func testTheSummaryCarriesTheFolder() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        let summary = manifest.summary(createdAt: 5, folderId: nil)

        XCTAssertEqual(summary.id, manifest.id)
        XCTAssertNil(summary.folderId)
        XCTAssertTrue(summary.hasAudio)
        XCTAssertEqual(summary.snippet, "Good afternoon.")
    }
}
