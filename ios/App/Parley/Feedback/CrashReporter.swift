import Foundation
import MetricKit
import ParleyKit

/// A crash or hang from an earlier run, as MetricKit delivered it, waiting for
/// either the auto-send or the user's answer to the banner.
struct PendingCrash: Codable, Equatable, Identifiable {
    /// Minted when the diagnostic arrives and kept for its whole life, so the
    /// report built from it has one id however many times the queue has to try
    /// — the server stores it once.
    let id: String
    /// `crash` or `hang`. Both are sent as `trigger: crash`; the kind decides
    /// only whether the next-launch banner may be shown (see `FeedbackCenter`).
    let kind: String
    /// `MXDiagnostic.jsonRepresentation()`, untouched. Cut down to size only
    /// when a report is built from it (`CrashDiagnosticJSON`).
    let json: Data
    let receivedAt: Date
}

/// The crashes the user has not decided about yet, on disk, so a banner that
/// was never answered — the app was closed with it up — is still there next
/// time. MetricKit delivers each diagnostic exactly once; if it were only held
/// in memory, closing the app would be the same as answering "no".
enum PendingCrashStore {
    /// Plenty for "the last few crashes". A build that crashes on every launch
    /// with auto-send off should not grow this directory without bound.
    static let capacity = 10

    private static func directory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
            create: true)
        let directory = base.appendingPathComponent("Parley/PendingCrashes", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func load() -> [PendingCrash] {
        guard let directory = try? directory(),
            let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil)
        else { return [] }
        return
            files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(PendingCrash.self, from: Data(contentsOf: $0)) }
            .sorted { $0.receivedAt < $1.receivedAt }
    }

    static func save(_ crash: PendingCrash) {
        guard let url = try? directory().appendingPathComponent("\(crash.id).json"),
            let data = try? JSONEncoder().encode(crash)
        else { return }
        try? data.write(to: url, options: .atomic)
        let all = load()
        if all.count > capacity { all.prefix(all.count - capacity).forEach { remove($0.id) } }
    }

    static func remove(_ id: String) {
        guard let url = try? directory().appendingPathComponent("\(id).json") else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

/// MetricKit's side of crash reporting: the system's own crash and hang
/// diagnostics, with no third-party SDK and no signal handler of ours.
///
/// On iOS 15 and later MetricKit hands the diagnostics of an earlier run to the
/// *next* launch, shortly after `MXMetricManager.shared.add(_:)`, which is why
/// the subscriber is added as early as the app's `init`. It is the only path
/// that can see a crash at all: the crashed process could not report itself,
/// and nothing about a crash reaches the cloud otherwise — which also makes it
/// the one layer that can explain a recording that never synced.
///
/// What arrives is symbolication-free call stacks (binary names, offsets and
/// UUIDs), the exception or signal, and the app and OS version. None of it is
/// user content.
final class CrashReporter: NSObject, MXMetricManagerSubscriber {
    /// At most this many crash diagnostics per delivery become reports, and at
    /// most one hang. A payload covers a day; a build that crashes in a loop
    /// would otherwise send a report per crash and hit the server's daily
    /// limit on its own.
    static let maxCrashesPerPayload = 3
    static let maxHangsPerPayload = 1

    /// Called on an arbitrary queue, with what this delivery produced.
    var onDiagnostics: (([PendingCrash]) -> Void)?

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var found: [PendingCrash] = []
        for payload in payloads {
            let now = Date()
            for crash in (payload.crashDiagnostics ?? []).prefix(Self.maxCrashesPerPayload) {
                found.append(
                    PendingCrash(
                        id: UUID().uuidString.lowercased(), kind: "crash",
                        json: crash.jsonRepresentation(), receivedAt: now))
            }
            for hang in (payload.hangDiagnostics ?? []).prefix(Self.maxHangsPerPayload) {
                found.append(
                    PendingCrash(
                        id: UUID().uuidString.lowercased(), kind: "hang",
                        json: hang.jsonRepresentation(), receivedAt: now))
            }
        }
        guard !found.isEmpty else { return }
        // To disk before anything else happens to them: MetricKit will not
        // deliver these again, and the send that follows may not finish.
        found.forEach(PendingCrashStore.save)
        AppLog.feedback.notice(
            "MetricKit delivered \(found.count, privacy: .public) diagnostic(s)")
        onDiagnostics?(found)
    }
}
