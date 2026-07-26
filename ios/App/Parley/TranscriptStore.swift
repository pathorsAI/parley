import Foundation
import ParleyKit

/// Transcript state for the live screen. Mirrors the desktop's
/// `upsertSegment` (src/lib/store.ts): segments are upserted by id, so a
/// growing run keeps replacing itself and the `-tail` row updates in place.
@MainActor
final class TranscriptStore: ObservableObject {
    @Published private(set) var segments: [TranscriptSegment] = []
    @Published var micLevel: Float = 0
    @Published var isRecording = false
    @Published var status = "idle"

    func upsert(_ seg: TranscriptSegment) {
        // An empty tail clears the row (same contract as the desktop UI).
        if seg.id.hasSuffix("-tail") && seg.text.isEmpty {
            segments.removeAll { $0.id == seg.id }
            return
        }
        if let i = segments.firstIndex(where: { $0.id == seg.id }) {
            segments[i] = seg
        } else {
            segments.append(seg)
        }
        // Keep the tail rendered last, matching the live feed's reading order.
        segments.sort { a, b in
            if a.id.hasSuffix("-tail") != b.id.hasSuffix("-tail") {
                return b.id.hasSuffix("-tail")
            }
            return a.startMs < b.startMs
        }
    }

    func clear() {
        segments = []
    }
}
