import Foundation
import ParleyKit

/// Replays canned Soniox relay frames through the REAL parser at realistic
/// timing — proves the transcript core + UI on-device before cloud auth
/// exists. The frames mimic what the hosted relay passes through byte-for-byte
/// (diarized speakers, interim tails, `<end>` endpoints).
enum DemoFeed {
    static let frames: [(delayMs: UInt64, json: String)] = [
        (400, #"{"tokens":[{"text":"那我","is_final":false,"start_ms":300,"end_ms":500,"speaker":"1"}]}"#),
        (500, #"{"tokens":[{"text":"那我們就","is_final":false,"start_ms":300,"end_ms":800,"speaker":"1"}]}"#),
        (600, #"{"tokens":[{"text":"那我們就先從報價開始談。","is_final":true,"start_ms":300,"end_ms":1600,"speaker":"1"},{"text":"<end>","is_final":true}]}"#),
        (900, #"{"tokens":[{"text":"好，","is_final":true,"start_ms":2100,"end_ms":2300,"speaker":"2"},{"text":"不過","is_final":false,"start_ms":2300,"end_ms":2500,"speaker":"2"}]}"#),
        (700, #"{"tokens":[{"text":"不過我們預算","is_final":false,"start_ms":2300,"end_ms":3000,"speaker":"2"}]}"#),
        (800, #"{"tokens":[{"text":"不過我們預算上限大概是三十萬。","is_final":true,"start_ms":2300,"end_ms":4200,"speaker":"2"},{"text":"<end>","is_final":true}]}"#),
        (900, #"{"tokens":[{"text":"了解，","is_final":true,"start_ms":4800,"end_ms":5000,"speaker":"1"}]}"#),
        (700, #"{"tokens":[{"text":"如果分兩期","is_final":false,"start_ms":5000,"end_ms":5600,"speaker":"1"}]}"#),
        (800, #"{"tokens":[{"text":"如果分兩期付款，第一期先做核心模組呢?","is_final":true,"start_ms":5000,"end_ms":7200,"speaker":"1"},{"text":"<end>","is_final":true}]}"#),
        (600, #"{"tokens":[{"text":"<fin>","is_final":true}],"finished":true}"#),
    ]

    /// Run the replay; calls `sink` on the MainActor for each emitted segment.
    static func run(sink: @escaping @MainActor (TranscriptSegment) -> Void) -> Task<Void, Never> {
        Task {
            let parser = SonioxStreamParser(source: "mix") { seg in
                Task { @MainActor in sink(seg) }
            }
            for frame in frames {
                try? await Task.sleep(for: .milliseconds(frame.delayMs))
                if Task.isCancelled { return }
                try? parser.process(frame.json)
            }
        }
    }
}
