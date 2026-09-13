import SwiftUI

/// The live level history, drawn the way Voice Memos draws it: thin vertical
/// bars symmetric about a centreline, newest at the right edge, the whole field
/// scrolling left as the recording runs, with a red playhead pinned at the right.
///
/// It replaced a 70×5 capsule meter. The capsule only ever answered "is sound
/// arriving", which the recording dot already answers; a scrolling waveform
/// answers "did it hear the last thing I said", which is the question someone
/// actually has while a phone is sitting on a table in the middle of a meeting.
/// It is also the shape every voice recorder on the platform uses, so it needs
/// no explaining.
///
/// ## Where the data comes from, and what it costs
///
/// `AudioCapture` already computes one RMS value per chunk on the audio thread
/// and `MeetingRecorder` publishes it as `micLevel` — a 4096-frame tap at the
/// hardware rate, so roughly one value every 85 ms, or about 12 a second. That
/// is the sampling rate, unchanged: this view appends the value it is handed and
/// never asks for more, so the cost on the main actor is exactly what the old
/// meter cost.
///
/// Drawing is one `Canvas` and one `Path` per frame inside a
/// `TimelineView(.animation)`, and the timeline exists **only while recording**.
/// Idle, it is a single static draw of the silence line rather than a 60 Hz
/// redraw of a thing that isn't moving.
///
/// Between two samples the field glides rather than jumping a whole bar every
/// 85 ms: the horizontal offset is interpolated from how long ago the last
/// sample landed. That interpolation is the only reason this needs an animation
/// timeline at all.
struct WaveformView: View {
    /// The newest RMS value, straight off `MeetingRecorder.micLevel`.
    let level: Float
    /// `MeetingRecorder.micSample` — changes on every chunk, even when `level`
    /// repeats, so silence keeps scrolling.
    let sample: Int
    /// A recording is running. False parks the view on a static silence line and
    /// clears the history, so the next meeting starts from an empty field.
    let isActive: Bool

    /// 2pt bar, 1pt gap — dense enough to read as a waveform rather than a bar
    /// chart, wide enough to survive a non-integral scale factor.
    private static let barWidth: CGFloat = 2
    private static let gap: CGFloat = 1
    /// Silence is still a mark. At 4pt a quiet passage reads as a dotted
    /// centreline instead of a gap the eye mistakes for "it stopped recording".
    private static let minBar: CGFloat = 4
    private static let height: CGFloat = 56
    /// How long `AudioCapture` takes to produce one value: a 4096-frame tap at
    /// 48 kHz. Only used to interpolate the scroll between samples, so being a
    /// few milliseconds out costs smoothness, never correctness.
    private static let interval: TimeInterval = 0.085
    /// Enough history for the widest phone (a 430pt-wide field holds ~144 bars)
    /// with room to spare, and small enough that the buffer never matters.
    private static let capacity = 256
    /// The same curve the old capsule meter used: speech RMS lives around
    /// 0.05–0.3, so ×6 puts normal talking near the top of the field without
    /// clipping every syllable.
    private static let gain: Float = 6

    @State private var levels: [Float] = []
    /// When the newest value landed, for the between-samples glide.
    @State private var lastSampleAt = Date.distantPast

    var body: some View {
        Group {
            if isActive {
                TimelineView(.animation) { timeline in
                    canvas(now: timeline.date)
                }
            } else {
                // Nothing is moving, so nothing needs a clock.
                canvas(now: lastSampleAt)
            }
        }
        .frame(height: Self.height)
        .onChange(of: sample) { _, _ in
            guard isActive else { return }
            levels.append(level)
            if levels.count > Self.capacity { levels.removeFirst(levels.count - Self.capacity) }
            lastSampleAt = Date()
        }
        .onChange(of: isActive) { _, active in
            if !active {
                levels = []
                lastSampleAt = .distantPast
            }
        }
        // A waveform says nothing a screen reader can use, and the status line
        // beside it already says the recording is running.
        .accessibilityHidden(true)
    }

    private func canvas(now: Date) -> some View {
        Canvas(opaque: false, rendersAsynchronously: false) { context, size in
            draw(&context, size: size, now: now)
        }
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize, now: Date) {
        let step = Self.barWidth + Self.gap
        guard size.width > step, size.height > Self.minBar else { return }
        // One extra bar so the one sliding off the left edge is drawn while it
        // is still half visible.
        let visible = Int((size.width / step).rounded(.up)) + 1
        let midY = size.height / 2

        // Older than the history: the field starts full of silence rather than
        // filling in from the right, which would read as a broken layout for the
        // first ten seconds of every meeting.
        let recent = Array(levels.suffix(visible))
        let frames = Array(repeating: Float(0), count: max(0, visible - recent.count)) + recent

        // The glide. `progress` is how far through the current 85 ms window we
        // are, and the whole field is shifted left by that fraction of one bar.
        let elapsed = now.timeIntervalSince(lastSampleAt)
        let progress = isActive ? min(1, max(0, elapsed / Self.interval)) : 0
        let shift = CGFloat(progress) * step

        var bars = Path()
        for (index, value) in frames.enumerated() {
            // Newest last, pinned to the right edge.
            let fromRight = frames.count - 1 - index
            let x = size.width - Self.barWidth - CGFloat(fromRight) * step - shift
            guard x + Self.barWidth > 0, x < size.width else { continue }
            let scaled = CGFloat(min(1, max(0, value * Self.gain)))
            let barHeight = Self.minBar + (size.height - Self.minBar) * scaled
            bars.addRoundedRect(
                in: CGRect(
                    x: x, y: midY - barHeight / 2,
                    width: Self.barWidth, height: barHeight),
                cornerSize: CGSize(width: Self.barWidth / 2, height: Self.barWidth / 2))
        }
        context.fill(bars, with: .color(Color(.secondaryLabel)))

        // The playhead: where "now" is. Recording red, because that is the one
        // thing on this screen the colour is reserved for.
        if isActive {
            context.fill(
                Path(CGRect(x: size.width - 1, y: 0, width: 1, height: size.height)),
                with: .color(Theme.recording))
        }
    }
}

#if DEBUG
    #Preview("Waveform") {
        VStack(spacing: 28) {
            WaveformView(level: 0.12, sample: 0, isActive: true)
            WaveformView(level: 0, sample: 0, isActive: false)
        }
        .padding(20)
        .background(Theme.background)
    }
#endif
