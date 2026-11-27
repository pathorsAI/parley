import SwiftUI

/// The three tabs, in the order the tab bar shows them.
enum AppTab: Hashable {
    case record, library, settings
}

/// Which tab is up, and requests that cross from one tab to another.
///
/// The selection used to be `@State` inside `MainTabs`, which meant nothing
/// below the tab bar could change it. Settings' "Show the getting-started list
/// again" has to: the list it brings back lives on the Library, and a button
/// that resets something the user cannot see reads as a button that did
/// nothing. So the selection is lifted here and handed down as an environment
/// object, and a cross-tab request is a counter the destination watches.
@MainActor
final class TabRouter: ObservableObject {
    @Published var tab: AppTab = .record

    /// Bumped each time something asks the Library to bring the checklist
    /// into view. A counter rather than a `Bool`, so two requests in a row are
    /// two changes and the Library never has to hand a flag back. The Library
    /// remembers the last value it acted on — it may not exist yet when the
    /// request is made (a tab is built on its first visit), and it has to act
    /// on a request it was not around to see change.
    @Published private(set) var checklistRequest = 0

    /// Switch to the Library and show the getting-started list at the top of it.
    func showGettingStarted() {
        checklistRequest += 1
        tab = .library
    }

    /// Bumped each time a meeting's upload settles and its result page should
    /// open: the phone's version of the desktop's End, which finishes saving
    /// and then opens the recording's report (`src/lib/meeting/controls.ts`
    /// `endMeeting`). A counter for the same reasons as `checklistRequest`:
    /// two meetings in a row are two changes, and a Library built for the
    /// first time by this very switch still has to act on a request it was not
    /// around to see change.
    @Published private(set) var endedMeetingRequest = 0
    /// What the latest `endedMeetingRequest` is about. Not published itself:
    /// it is always written just before the counter, and the counter is what
    /// the Library watches.
    private(set) var endedMeeting: EndedMeeting?

    /// Switch to the Library and open the result page of the meeting that has
    /// just landed in the cloud.
    func openEndedMeeting(_ meeting: EndedMeeting) {
        endedMeeting = meeting
        endedMeetingRequest += 1
        tab = .library
    }
}

/// A meeting that ended and landed in the cloud, as its result page needs it:
/// the recording itself, plus what only the record screen knew about it —
/// whether it was named or filed live (the filing card skips those halves)
/// and how the microphone held up (the `mic_recovery` prompt).
struct EndedMeeting {
    let settled: MeetingRecorder.Settled
    /// Nil only if the recorder never noted the meeting as finished, which a
    /// settled upload always does first. Optional so a missing one costs the
    /// prompt, never the handoff.
    let finished: MeetingRecorder.FinishedMeeting?

    var id: String { settled.id }
}
