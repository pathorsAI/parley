import ParleyKit
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

    /// Bumped each time a meeting draft's 開始 is pressed: the phone's version
    /// of the desktop's `startDraft` (`src/components/home/DraftRow.tsx`). The
    /// Record screen watches it and starts the meeting with the draft's name,
    /// folder and context — or, with a meeting already going, only comes up,
    /// as the desktop refuses a second meeting and brings the first one's
    /// window forward. A counter for the same reasons as `checklistRequest`.
    @Published private(set) var draftStartRequest = 0
    /// What the latest `draftStartRequest` is about. Written just before the
    /// counter, which is what the Record screen watches.
    private(set) var draftStart: DraftStart?

    /// Switch to Record and start a meeting from a draft.
    func startDraft(_ start: DraftStart) {
        draftStart = start
        draftStartRequest += 1
        tab = .record
    }

    /// Drafts a meeting has been started from on this phone. The desktop
    /// deletes a draft it records ("taking a draft is recording it"), but
    /// the phone only reads drafts and never writes them, so it hides the
    /// one it took instead; the cloud copy stays for the desktop to settle.
    /// Kept across launches, and pruned to the drafts the cloud still lists
    /// (`pruneStartedDrafts`), so the set never outgrows the draft list.
    @Published private(set) var startedDraftIDs: Set<String>

    private static let startedDraftsKey = "ParleyStartedMeetingDraftIDs"

    init() {
        #if DEBUG
            // The demo's fixtures are the same every launch; a draft hidden in
            // one screenshot run must not be missing from the next.
            if ScreenshotDemo.isActive {
                startedDraftIDs = []
                return
            }
        #endif
        startedDraftIDs = Set(
            UserDefaults.standard.stringArray(forKey: Self.startedDraftsKey) ?? [])
    }

    /// A meeting was started from this draft: hide it on this phone.
    func markDraftStarted(_ id: String) {
        guard !startedDraftIDs.contains(id) else { return }
        startedDraftIDs.insert(id)
        saveStartedDrafts()
    }

    /// Forget hidden drafts the cloud no longer lists. Only with a list that
    /// actually loaded: an empty answer from a failed request would unhide
    /// nothing worth unhiding, but would lose every id.
    func pruneStartedDrafts(keeping listed: Set<String>) {
        let kept = startedDraftIDs.intersection(listed)
        guard kept != startedDraftIDs else { return }
        startedDraftIDs = kept
        saveStartedDrafts()
    }

    private func saveStartedDrafts() {
        #if DEBUG
            if ScreenshotDemo.isActive { return }
        #endif
        UserDefaults.standard.set(Array(startedDraftIDs).sorted(), forKey: Self.startedDraftsKey)
    }
}

/// A meeting to start from a draft, as the Record screen needs it: what the
/// desktop's `prepFromDraft` carries into its meeting. Resolved on the
/// Library, which has the draft and the personal folders in hand.
struct DraftStart {
    let draftId: String
    /// The draft's title, trimmed; empty leaves the meeting unnamed.
    let title: String
    /// The draft's folder, when it is one of the personal folders; nil
    /// leaves the app's default destination.
    let folder: MeetingRecorder.ChosenFolder?
    /// The context the desktop prepared (its 補充背景), saved into the
    /// recording's `meetingContext`.
    let context: String
    /// The draft itself, for the record screen's 查看會議草稿 sheet.
    let draft: CloudMeetingDraft
    /// Its folder's name, for that sheet.
    let folderName: String?
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
