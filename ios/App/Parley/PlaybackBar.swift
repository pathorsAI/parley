import ParleyKit
import SwiftUI
import UIKit

/// The player, pinned under the navigation bar on a recording's detail screen:
/// the whole file as one overview waveform, and one row of controls.
///
/// ## Why an overview and not a scrolling waveform
///
/// The live screen's `WaveformView` scrolls, because during a meeting the
/// question is "did it hear the last thing I said". Afterwards the question is
/// the opposite one — "where in this hour was the bit about the price" — and only
/// a view of the *whole* file can answer it. So this is static: one bar per 5pt
/// of width, the entire recording, played portion in signal blue.
///
/// The bar geometry — 3pt wide, 2pt apart, capsule ends, symmetric about a
/// centreline — is shared with `WaveformView` on purpose. A recording and its
/// playback are the same object, and drawing them in two visual languages makes
/// them look like two features. The strip is also half the height it was, for
/// the same reason the live one is: a player pinned under the navigation bar
/// should hand the page back to the transcript as fast as it can.
///
/// ## Three states, one height
///
/// The audio is either on the phone, arriving, or not here yet, and the block is
/// the same height in all three (`Layout.blockHeight`) so the transcript under it
/// does not jump when a download lands. Absent is a single blue text button;
/// arriving and preparing are a thin progress line.
struct PlaybackBar: View {
    @ObservedObject var controller: PlaybackController
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var downloads: AudioDownloadModel
    let summary: CloudRecordingSummary
    /// nil = personal scope. Org recordings have no download endpoint of their
    /// own (see `LibraryView.downloadAction`), so the absent state there offers
    /// nothing rather than a button that would 404.
    let orgId: String?
    /// Moments worth finding on the timeline — the analysis's findings — drawn
    /// as small dots on the waveform. Tapping one seeks there.
    var markers: [TimeInterval] = []

    enum Layout {
        /// Half of the 72pt it started at. Still the whole scrub target, and
        /// comfortably above the 32pt a finger needs — the drag's precision
        /// tiers come from *vertical* travel outside the strip, not from room
        /// inside it, so a shorter strip costs the gesture nothing.
        static let waveformHeight: CGFloat = 36
        static let controlsHeight: CGFloat = 44
        static let sidePadding: CGFloat = 20
        /// What every state occupies. See the type doc.
        static var blockHeight: CGFloat { waveformHeight + controlsHeight }
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        // Full height only once there is a waveform to show. Before the audio
        // is on the phone the block is one control row: an 80pt band holding a
        // single line of blue text reads as a hole in the page, not a player.
        .frame(height: hasWaveform ? Layout.blockHeight : Layout.controlsHeight)
        .padding(.horizontal, Layout.sidePadding)
        // Room above and below, so the waveform does not start hard against the
        // navigation bar's own hairline and the control row does not sit on the
        // block's.
        .padding(.vertical, 8)
        .background(Theme.background)
        // The hairline is the whole of the separation: the block is the same
        // white as the page, so a rule is what says "the transcript scrolls
        // under this" without a card, a shadow or a tinted band.
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
        }
    }

    /// Whether the block is showing the player itself rather than one of the
    /// one-line states (download offer, progress, preparing, failure).
    private var hasWaveform: Bool {
        if case .ready = controller.phase { return true }
        return false
    }

    @ViewBuilder
    private var content: some View {
        switch controller.phase {
        case .ready:
            player
        case .preparing:
            line(String(localized: "Preparing…"), fraction: nil)
        case .failed(let message):
            // The same shape as "preparing", with the reason where the progress
            // was. A failure here is not actionable — the file is on the phone
            // and will not open — so it is a sentence, not a retry.
            Text(verbatim: message)
                .font(.parley.footnote)
                .foregroundStyle(Theme.destructive)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .idle:
            absent
        }
    }

    /// Not on the phone yet. The download is the same `AudioDownloadModel` the
    /// library row and the toolbar drive, so a download started in any of the
    /// three shows here too.
    @ViewBuilder
    private var absent: some View {
        switch downloads.state(for: summary.id) {
        case .downloading(let fraction):
            line(nil, fraction: fraction)
        case .local:
            // The file is here and the player has not opened it yet — one frame,
            // between the view appearing and `PlaybackController.load` running.
            // Blank rather than the download button: offering to fetch something
            // already on the phone would be a lie, even for a frame.
            Color.clear
        case .absent, .failed:
            if orgId == nil {
                Button {
                    Task { await downloads.download(summary.id, cloud: app.cloud) }
                } label: {
                    // The size the design asked for is deliberately absent: the
                    // library summary carries `hasAudio` but no byte count, and
                    // a number invented here would be a guess in the one place
                    // a person is deciding whether to spend their data on it.
                    Text("Download to play back")
                        .font(.parley.bodyEmphasized)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Color.clear
            }
        }
    }

    /// A thin determinate line where the button was, with a caption under it.
    /// `fraction: nil` is the indeterminate case.
    private func line(_ caption: String?, fraction: Double?) -> some View {
        VStack(spacing: 10) {
            Group {
                if let fraction {
                    ProgressView(value: fraction)
                } else {
                    ProgressView()
                }
            }
            .progressViewStyle(.linear)
            .frame(height: 2)
            if let caption {
                Text(verbatim: caption)
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var player: some View {
        VStack(spacing: 0) {
            ScrubbableWaveform(controller: controller, markers: markers)
                .frame(height: Layout.waveformHeight)
            PlaybackControls(controller: controller)
                .frame(height: Layout.controlsHeight)
        }
    }
}

// MARK: - the waveform and the scrub

/// The overview waveform, and the only place the recording can be scrubbed.
///
/// ## YouTube's drag-up-for-precision, exactly
///
/// A 350pt-wide bar over a 40-minute meeting is 7 seconds per point, so a
/// one-finger-width correction is a minute. YouTube's answer — the one everybody
/// has already learnt — is that lifting the finger away from the bar while still
/// dragging makes it finer: three tiers, and the *scale* of the horizontal
/// translation changes rather than the position jumping.
///
/// Two things are load-bearing in the implementation:
///
/// - The time is **accumulated**, not recomputed from the start of the drag.
///   Recomputing would mean that crossing into the ¼ tier snaps the playhead
///   back to a quarter of where it was, which is the bug the "not by a jump"
///   note in the design is about.
/// - The tier is taken from the **absolute** vertical distance, not from upward
///   distance only. This is the one deliberate departure from YouTube: their
///   player sits at the bottom of the screen so there is nothing but room above
///   it, while this block is pinned directly under the navigation bar, where
///   90pt of upward travel does not exist. Down is where the room is, so both
///   directions count.
private struct ScrubbableWaveform: View {
    @ObservedObject var controller: PlaybackController
    let markers: [TimeInterval]

    /// Tier boundaries in points of vertical travel, and what each does to the
    /// horizontal scale. 1× is "full width = full duration".
    private static let tiers: [(distance: CGFloat, scale: Double, label: LocalizedStringKey?)] = [
        (0, 1, nil),
        (40, 0.25, "Fine"),
        (90, 1.0 / 16, "Finer"),
    ]

    /// The same geometry as `WaveformView` — see the type doc on why the two
    /// waveforms are drawn alike.
    private static let barWidth: CGFloat = 3
    private static let gap: CGFloat = 2
    /// Silence is still a mark — the same reason `WaveformView` has a floor. At
    /// one bar width it draws as a dot, so a quiet stretch of an hour-long file
    /// reads as a dotted centreline rather than a gap in the recording.
    private static let minBar: CGFloat = 3
    /// The playhead's line. Thin, because it is a position rather than a
    /// marker, but thick enough to be dragged towards.
    private static let playheadWidth: CGFloat = 2

    @State private var scrub: Scrub?

    /// Live state for one drag. Absent when no finger is down.
    private struct Scrub {
        var time: TimeInterval
        var lastX: CGFloat
        var finger: CGPoint
        var tier: Int
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            Canvas(opaque: false, rendersAsynchronously: false) { context, canvasSize in
                draw(&context, size: canvasSize)
            }
            .contentShape(Rectangle())
            .gesture(drag(width: size.width))
            .overlay(alignment: .topLeading) { markerDots(in: size) }
            .overlay(alignment: .topLeading) { timeLabel(in: size) }
        }
        .accessibilityElement()
        .accessibilityLabel("Scrub")
        .accessibilityValue(
            Text(verbatim: PlaybackClock.string(controller.currentTime)))
        .accessibilityAdjustableAction { direction in
            // The drag is unreachable with VoiceOver on, so the timeline is an
            // adjustable instead: one swipe is 15 seconds, the same step every
            // podcast player uses.
            let step: TimeInterval = direction == .increment ? 15 : -15
            controller.seek(to: controller.currentTime + step)
        }
    }

    // MARK: drawing

    private func draw(_ context: inout GraphicsContext, size: CGSize) {
        let step = Self.barWidth + Self.gap
        guard size.width > step, size.height > Self.minBar else { return }
        let count = max(1, Int(size.width / step))
        let bars = AudioPeaks.resample(controller.peaks, to: count)
        // Normalised to the loudest moment rather than by a fixed gain: an hour
        // of a phone on a table across a boardroom is quiet all the way through,
        // and a fixed gain draws that as a flat line. The floor stops a silent
        // file being amplified into noise.
        let loudest = max(bars.max() ?? 0, 0.02)
        let midY = size.height / 2
        let progress =
            controller.duration > 0
            ? min(1, max(0, controller.currentTime / controller.duration)) : 0
        let playheadX = size.width * CGFloat(progress)

        var played = Path()
        var unplayed = Path()
        for (index, value) in bars.enumerated() {
            let x = CGFloat(index) * step
            let scaled = CGFloat(min(1, max(0, value / loudest)))
            let height = Self.minBar + (size.height - Self.minBar) * scaled
            // Symmetric about the centreline, the same as the live waveform.
            let rect = CGRect(
                x: x, y: midY - height / 2, width: Self.barWidth, height: height)
            let rounded = CGSize(width: Self.barWidth / 2, height: Self.barWidth / 2)
            if x + Self.barWidth <= playheadX {
                played.addRoundedRect(in: rect, cornerSize: rounded)
            } else {
                unplayed.addRoundedRect(in: rect, cornerSize: rounded)
            }
        }
        // Blue is what has been heard — the part of this recording that is
        // happening, or has happened, now. Both sides are stated softly: the
        // waveform is a map of the file, not the loudest thing on the screen.
        context.fill(played, with: .color(Theme.primary.opacity(0.9)))
        context.fill(unplayed, with: .color(Color(.tertiaryLabel).opacity(0.5)))

        // The playhead, in ink. Not blue: the blue is already saying which side
        // of it has played, and a blue line on a blue field would vanish. A
        // rounded 2pt line rather than a full-bleed rule — it is a control, so
        // it has to be visible, but it belongs to the same soft geometry as the
        // bars it sits among.
        if controller.duration > 0 {
            var playhead = Path()
            playhead.addRoundedRect(
                in: CGRect(
                    x: min(
                        size.width - Self.playheadWidth,
                        max(0, playheadX - Self.playheadWidth / 2)),
                    y: 0, width: Self.playheadWidth, height: size.height),
                cornerSize: CGSize(
                    width: Self.playheadWidth / 2, height: Self.playheadWidth / 2))
            context.fill(playhead, with: .color(Color(.label)))
        }
    }

    // MARK: finding markers

    /// A dot per finding along the top edge of the strip, in ink with a ring
    /// of page colour so it reads over a loud bar as well as over silence.
    ///
    /// Each dot is its own button with a thumb-sized target. Laid over the
    /// waveform, the targets take a tap that lands on a dot before the scrub
    /// can, which is the point — and nothing else: a drag that starts on one is
    /// still a tap-sized area in a strip that is otherwise all scrub.
    @ViewBuilder
    private func markerDots(in size: CGSize) -> some View {
        if controller.duration > 0, size.width > 0 {
            ForEach(Array(markers.enumerated()), id: \.offset) { _, time in
                let x = size.width * CGFloat(min(1, max(0, time / controller.duration)))
                Button {
                    controller.seek(to: time)
                } label: {
                    Circle()
                        .fill(Color(.label))
                        .frame(width: 6, height: 6)
                        .overlay(Circle().stroke(Theme.background, lineWidth: 1.5))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // Centred on the moment, riding the strip's top edge.
                .offset(x: x - 12, y: -9)
                .accessibilityLabel(
                    Text("Highlight at \(PlaybackClock.string(time))"))
            }
        }
    }

    // MARK: the floating label

    @ViewBuilder
    private func timeLabel(in size: CGSize) -> some View {
        if let scrub {
            let pillWidth: CGFloat = 96
            let pillHeight: CGFloat = scrub.tier > 0 ? 44 : 28
            VStack(spacing: 1) {
                Text(verbatim: PlaybackClock.string(scrub.time))
                    .font(.parley.footnote.monospacedDigit())
                    .foregroundStyle(Color(.label))
                if let label = Self.tiers[scrub.tier].label {
                    Text(label)
                        .font(.parley.caption2)
                        .foregroundStyle(Color(.secondaryLabel))
                }
            }
            .frame(width: pillWidth, height: pillHeight)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .fill(Theme.background)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                            .stroke(Color(.separator), lineWidth: 0.5)))
            // Follows the finger horizontally and sits above it, clamped to the
            // block's own bounds: the block is pinned under the navigation bar,
            // so a pill that floated freely above the finger would end up behind
            // the title.
            .offset(
                x: min(max(0, scrub.finger.x - pillWidth / 2), size.width - pillWidth),
                y: min(
                    max(0, scrub.finger.y - pillHeight - 12),
                    max(0, size.height - pillHeight)))
            .allowsHitTesting(false)
        }
    }

    // MARK: the gesture

    private func drag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard controller.duration > 0, width > 0 else { return }
                var live =
                    scrub
                    ?? Scrub(
                        time: controller.currentTime, lastX: value.location.x,
                        finger: value.location, tier: 0)

                let tier = Self.tier(for: value.location.y - value.startLocation.y)
                if tier != live.tier {
                    live.tier = tier
                    Self.tierChanged()
                }

                // Accumulate. See the type doc on why this is not recomputed
                // from `startLocation`.
                let secondsPerPoint = controller.duration / Double(width)
                let delta = Double(value.location.x - live.lastX)
                live.lastX = value.location.x
                live.finger = value.location
                live.time = min(
                    controller.duration,
                    max(0, live.time + delta * secondsPerPoint * Self.tiers[tier].scale))

                scrub = live
                // Live, so the audio keeps playing from where the finger is —
                // or stays paused, which the controller handles by doing nothing
                // but moving the playhead.
                controller.seek(to: live.time)
            }
            .onEnded { _ in
                // Nothing to apply: every frame of the drag already seeked, so
                // release is simply the end of the label.
                scrub = nil
            }
    }

    private static func tier(for verticalTravel: CGFloat) -> Int {
        let distance = abs(verticalTravel)
        var tier = 0
        for (index, entry) in tiers.enumerated() where distance >= entry.distance {
            tier = index
        }
        return tier
    }

    /// A light tap on each tier change — the only way to know the sensitivity
    /// changed without looking away from the waveform.
    private static func tierChanged() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

// MARK: - the control row

private struct PlaybackControls: View {
    @ObservedObject var controller: PlaybackController

    var body: some View {
        HStack(spacing: 14) {
            playPause
            Text(
                verbatim:
                    "\(PlaybackClock.string(controller.currentTime)) / \(PlaybackClock.string(controller.duration))"
            )
            .font(.parley.footnote.monospacedDigit())
            .foregroundStyle(Color(.secondaryLabel))
            Spacer(minLength: 0)
            speed
        }
    }

    /// A 36pt blue disc. Blue because it is tappable *and* because the player is
    /// the thing happening now — the two rules the colour serves both point here.
    private var playPause: some View {
        Button {
            controller.toggle()
        } label: {
            Circle()
                .fill(Theme.primary)
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: controller.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        // The triangle's visual centre is left of its bounding
                        // box's centre; a play glyph centred by its box always
                        // looks a hair too far left in a circle.
                        .offset(x: controller.isPlaying ? 0 : 1)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(controller.isPlaying ? "Pause" : "Play")
    }

    /// Tap cycles, long-press opens the full list. `Menu(primaryAction:)` is
    /// exactly that pairing, so neither behaviour needs a gesture of its own.
    private var speed: some View {
        Menu {
            Picker("Playback speed", selection: rateBinding) {
                ForEach(PlaybackController.menu, id: \.self) { value in
                    Text(verbatim: PlaybackRate.label(value)).tag(value)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Text(verbatim: PlaybackRate.label(controller.rate))
                .font(.parley.bodyEmphasized.monospacedDigit())
                .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                .contentShape(Rectangle())
        } primaryAction: {
            controller.cycleRate()
        }
        .accessibilityLabel("Playback speed")
    }

    private var rateBinding: Binding<Double> {
        Binding(get: { controller.rate }, set: { controller.setRate($0) })
    }
}

#if DEBUG
    #Preview("Playback controls") {
        VStack(spacing: 28) {
            PlaybackControls(controller: PlaybackController(recordingId: "preview"))
            Text(verbatim: PlaybackRate.label(1.25))
        }
        .padding(20)
        .background(Theme.background)
    }
#endif
