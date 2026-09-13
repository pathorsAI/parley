import AVFoundation
import Foundation
import ParleyKit
import SwiftUI

/// One recording's playback, for one detail screen.
///
/// ## The decode path, and why there is no Ogg parser here
///
/// Recordings are 16 kHz mono Ogg/Opus — what `OggOpusEncoder` writes and what
/// `PUT /recordings/:id/audio` holds. The plan allowed for two ways to play
/// that: hand it to AVFoundation, or demux the Ogg by hand and transcode to CAF
/// once. AVFoundation wins: `AVAudioPlayer(contentsOf:)` opens the file,
/// reports the right duration, seeks, and honours `enableRate`, and
/// `ExtAudioFile` reads the same file's PCM for the waveform (see
/// `AudioPeaks`). Both are covered by `AudioPeaksTests`, which is the test to
/// look at if playback ever stops working on a new OS: if it goes red, the
/// hand-written demuxer is back on the table.
///
/// Two Ogg quirks survive that and shape the code below:
///
/// - Opening is **not free**. There is no frame count in an Ogg header, so
///   AudioToolbox finds the duration by walking to the last page. For a
///   40-minute meeting that is real work, and it is why the open happens off the
///   main actor behind a `Preparing…` state rather than in a property getter.
/// - `AVAudioFile(forReading:)` opens the same file but reports `length == 0`
///   and then throws on `read`. Do not reach for it here.
///
/// ## What it will not do
///
/// It never starts while the microphone is in use. A live meeting and a playing
/// recording would fight over the audio session, and the loser is always the
/// meeting — the one thing in the app that cannot be repeated. So `play()`
/// checks `MeetingRecorder.holdsTheMicrophone` and the dictation coordinator
/// first and simply does nothing, with nothing shown for it: the play button is
/// a button on a screen you reached *from* the library, and if you are recording
/// you know you are recording.
@MainActor
final class PlaybackController: NSObject, ObservableObject {

    /// Where the audio is, from this screen's point of view. `absent` is the
    /// download model's business, not this object's — the block draws the
    /// download button from `AudioDownloadModel` and only builds a controller
    /// once there is a file.
    enum Phase: Equatable {
        /// No file handed over yet.
        case idle
        /// Opening the file. See the type doc on why this is a state.
        case preparing
        case ready
        case failed(String)
    }

    /// The speed cycle the text button steps through, and the menu's middle.
    static let cycle: [Double] = [1, 1.25, 1.5, 2]
    /// Everything the long-press menu offers.
    static let menu: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
    /// Held by an edge-zone press. Not in the cycle: it is a gesture, not a
    /// setting, and it must not become the persisted rate.
    static let heldRate: Double = 2
    /// The same key `@AppStorage("playbackRate")` would use, so the value is
    /// shared with any view that reads it that way.
    static let rateKey = "playbackRate"

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    /// The speed the user chose. `2×` while an edge zone is held is *not* this —
    /// see `isHoldingTwoX`.
    @Published private(set) var rate: Double
    @Published private(set) var isHoldingTwoX = false
    /// The overview waveform, or empty while it is still being computed. The
    /// player is usable either way; the waveform draws a flat line until this
    /// arrives.
    @Published private(set) var peaks: [Float] = []

    /// Bumped by every `seek(to:)`.
    ///
    /// A counter rather than a closure or a delegate because the thing that cares
    /// is the transcript's auto-follow, two views away: it resumes on any seek,
    /// and `onChange(of:)` over a counter is how a SwiftUI view observes an
    /// *event* on an object rather than a value. A repeated seek to the same
    /// second still counts as one, which is what a drag needs.
    @Published private(set) var seekGeneration = 0

    private var player: AVAudioPlayer?
    /// Which file `player` holds, so a `.task` that re-runs does not reopen it
    /// and a *different* file does.
    private var loadedURL: URL?
    private var ticker: Task<Void, Never>?
    private var peaksTask: Task<Void, Never>?
    /// Raised from the main actor, polled from the peaks thread between reads —
    /// the computation is synchronous and blocking, so `Task.isCancelled` cannot
    /// reach inside it. Replaced rather than lowered on the next load: a flag
    /// that can go back down is a flag two computations can disagree about.
    private var peaksCancelled = Flag()
    private var sessionActive = false
    private let store: LocalAudioStore
    private let recordingId: String

    init(recordingId: String, store: LocalAudioStore = .shared) {
        self.recordingId = recordingId
        self.store = store
        let saved = UserDefaults.standard.double(forKey: Self.rateKey)
        // An unset key reads as 0, which is not a speed.
        self.rate = Self.menu.contains(saved) ? saved : 1
        super.init()
    }

    deinit {
        ticker?.cancel()
        peaksTask?.cancel()
        peaksCancelled.raise()
        // The session is handed back here as well as on pause: a screen popped
        // mid-playback must not leave `.playback` active, or the next meeting
        // starts by fighting for a category it should have had for free.
        player?.stop()
        if sessionActive {
            try? AVAudioSession.sharedInstance()
                .setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // MARK: opening the file

    /// Open `url` and, once it is playable, start measuring the waveform.
    ///
    /// Idempotent for the file already open — the view calls this from a `.task`
    /// that re-runs on every re-render, and a second call must not restart
    /// playback. A *different* file replaces the current one, which is the
    /// "download removed and fetched again while the screen was open" case.
    func load(url: URL) async {
        guard loadedURL != url else { return }
        unload()
        peaksCancelled = Flag()
        loadedURL = url
        phase = .preparing

        let opened: Result<AVAudioPlayer, Error> = await Task.detached {
            do {
                let player = try AVAudioPlayer(contentsOf: url)
                // Before `prepareToPlay()`: setting it afterwards is silently
                // ignored on some builds, and a rate that does nothing is worse
                // than no rate control at all.
                player.enableRate = true
                // The waveform is drawn from the file, not from the output
                // meter, so metering would cost a buffer scan per frame for
                // nothing.
                player.isMeteringEnabled = false
                player.prepareToPlay()
                return .success(player)
            } catch {
                return .failure(error)
            }
        }.value

        switch opened {
        case .failure(let error):
            phase = .failed(error.localizedDescription)
        case .success(let player):
            player.delegate = self
            player.rate = Float(rate)
            self.player = player
            duration = player.duration
            phase = .ready
            startPeaks(url: url, seconds: player.duration)
        }
    }

    /// Back to having no file. Called when the audio is removed from the phone
    /// while the screen is open — the block goes back to offering the download,
    /// and the player must not be left holding a deleted file, an active audio
    /// session, and a duration for something that is gone.
    func unload() {
        player?.stop()
        player = nil
        loadedURL = nil
        stopTicking()
        releaseSession()
        peaksTask?.cancel()
        peaksCancelled.raise()
        isPlaying = false
        isHoldingTwoX = false
        currentTime = 0
        duration = 0
        peaks = []
        phase = .idle
    }

    /// Cached if it has been computed before, measured off the main actor if not.
    ///
    /// A cache written for a different file — a download removed and replaced
    /// under the same recording id — is spotted by its duration and recomputed
    /// rather than drawn over the wrong timeline.
    private func startPeaks(url: URL, seconds: TimeInterval) {
        if let cached = store.peaks(for: recordingId),
            abs(cached.seconds - seconds) < 0.5
        {
            peaks = cached.peaks
            return
        }
        let id = recordingId
        let store = store
        let cancelled = peaksCancelled
        peaksTask = Task { [weak self] in
            // No `onProgress`. `AudioPeaks.compute` offers it and it is tested,
            // but nothing on this screen would draw it: the waveform's own
            // design is that the player is usable the moment the audio opens and
            // draws a flat line until the peaks land, so a second progress bar
            // would be reporting on something the person is not waiting for.
            let computed = await Task.detached(priority: .utility) {
                try? AudioPeaks.compute(
                    url: url, expectedSeconds: seconds,
                    isCancelled: { cancelled.isRaised })
            }.value
            guard let self, !Task.isCancelled, let computed else { return }
            self.peaks = computed.peaks
            store.putPeaks(computed, for: id)
        }
    }

    // MARK: transport

    /// True when a play tap would do something. False while the microphone is
    /// in use anywhere in the app — see the type doc.
    var canPlay: Bool {
        guard isSeekable else { return false }
        return !MeetingRecorder.holdsTheMicrophone && !DictationCoordinator.shared.active
    }

    /// There is a timeline to move along. True even while the microphone is
    /// busy: a scrub or a timecode tap positions the playhead without asking for
    /// the audio session, so it is allowed where `play()` is not.
    var isSeekable: Bool {
        guard case .ready = phase else { return false }
        return duration > 0
    }

    func play() {
        guard canPlay, let player else { return }
        activateSession()
        // A file played to the end restarts rather than refusing: the button
        // still says "play", so it has to play.
        if currentTime >= duration - 0.05 { seek(to: 0) }
        player.rate = Float(isHoldingTwoX ? Self.heldRate : rate)
        guard player.play() else { return }
        isPlaying = true
        startTicking()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        stopTicking()
        releaseSession()
    }

    func toggle() {
        isPlaying ? pause() : play()
    }

    /// Move the playhead. Applied live, so a scrub during playback keeps playing
    /// from the new position rather than stopping and resuming.
    func seek(to time: TimeInterval) {
        guard let player else { return }
        let clamped = min(max(0, time), max(0, duration))
        player.currentTime = clamped
        currentTime = clamped
        seekGeneration += 1
    }

    func setRate(_ value: Double) {
        rate = value
        UserDefaults.standard.set(value, forKey: Self.rateKey)
        if !isHoldingTwoX { player?.rate = Float(value) }
    }

    /// The next speed the `1×` button steps to. Off-cycle speeds chosen from the
    /// menu (0.75×, 1.75×) step to the next one *above* them rather than
    /// restarting at 1×, so a tap after a menu choice is still a nudge forwards.
    func cycleRate() {
        let next = Self.cycle.first { $0 > rate } ?? Self.cycle[0]
        setRate(next)
    }

    /// An edge zone is held. Deliberately does not touch `rate`: the chosen
    /// speed has to survive the gesture, because releasing restores it.
    func holdTwoX(_ holding: Bool) {
        guard isHoldingTwoX != holding else { return }
        isHoldingTwoX = holding
        player?.rate = Float(holding ? Self.heldRate : rate)
    }

    // MARK: the clock

    /// 10 Hz, and only while playing. `AVAudioPlayer.currentTime` is a poll —
    /// there is no callback — so the choice is a timer or nothing, and 10 Hz is
    /// the slowest rate at which a 1pt playhead crossing a 350pt waveform still
    /// looks continuous.
    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, let player = self.player, self.isPlaying else { return }
                self.currentTime = player.currentTime
            }
        }
    }

    private func stopTicking() {
        ticker?.cancel()
        ticker = nil
    }

    // MARK: the audio session

    /// `.playback` for as long as something is playing, and handed straight back
    /// afterwards. Holding it would make this screen the reason the next meeting
    /// cannot open the microphone.
    private func activateSession() {
        guard !sessionActive else { return }
        let session = AVAudioSession.sharedInstance()
        // `.spokenAudio` is the mode for speech the user is listening to: it
        // ducks other audio the way a podcast does rather than mixing.
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        sessionActive = true
    }

    private func releaseSession() {
        guard sessionActive else { return }
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
    }

    /// A box the blocking peaks computation can poll from another thread.
    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var raised = false
        var isRaised: Bool {
            lock.lock()
            defer { lock.unlock() }
            return raised
        }
        func raise() {
            lock.lock()
            raised = true
            lock.unlock()
        }
    }
}

extension PlaybackController: AVAudioPlayerDelegate {
    /// Park the playhead at the end rather than snapping it back to zero: "this
    /// is over" is the true state, and the next play tap restarts (see `play`).
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.isPlaying = false
            self.currentTime = self.duration
            self.stopTicking()
            self.releaseSession()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.isPlaying = false
            self.stopTicking()
            self.releaseSession()
            self.phase = .failed(
                error?.localizedDescription ?? String(localized: "Couldn't play this recording"))
        }
    }
}

/// How a speed is written: `1×`, `1.25×`, `2×`.
///
/// Not a string in the catalog, and deliberately so. It is a number and the
/// multiplication sign, both of which the locale's own number formatting gets
/// right — `0.75×` is `0,75×` in a comma locale for free, and a translator
/// handed `1.25×` to translate would have nothing to do with it.
enum PlaybackRate {
    static func label(_ rate: Double) -> String {
        let number = rate.formatted(
            .number.precision(.fractionLength(0...2)).grouping(.never))
        return "\(number)×"
    }
}

/// `12:34`, or `1:02:03` past the hour. Tabular by convention at every call
/// site — the digits sit under a moving playhead and must not shuffle.
enum PlaybackClock {
    static func string(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.isFinite ? max(0, seconds.rounded(.down)) : 0)
        if total >= 3600 {
            return String(format: "%d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
        }
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
