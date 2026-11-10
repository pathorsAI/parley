import Foundation

/// The one order every recording list on the phone is drawn in: newest first,
/// by when the meeting happened (`createdAt`).
///
/// One function rather than a `sorted` at each list, so a folder page, the
/// "All" page, a search and an org library cannot drift apart. Recordings with
/// the same `createdAt` (two imports of the same file, a desktop and a phone
/// copy) are ordered by id, so a reload never swaps two rows that are equal on
/// time.
public enum RecordingOrder {

    public static func newestFirst(_ recordings: [CloudRecordingSummary]) -> [CloudRecordingSummary] {
        recordings.sorted { a, b in
            a.createdAt != b.createdAt ? a.createdAt > b.createdAt : a.id < b.id
        }
    }
}
