import ParleyKit
import SwiftUI

/// The sign-in page's little film: the product's four beats, assembling
/// themselves once in about seven seconds and then resting.
///
/// The page used to carry three static lines — record, file, share — which
/// said what the app does in the one register nobody reads on a first screen.
/// This shows it instead, with the app's own pieces in the app's own visual
/// language (plain text, hairlines, one tint): a recording starts; the sample
/// call's first three lines type themselves in with who said them; the
/// suggestion card flies into the customer's folder; the share mark lights.
/// One caption under the stage names the beat.
///
/// Driven by one `TimelineView` against `LapMotion.introBeats` (ParleyKit,
/// tested), so every piece is a pure function of the time since it appeared.
/// It plays once. With Reduce Motion the stage starts at its final state.
struct IntroStage: View {
    private struct Line {
        let speaker: String
        let isMe: Bool
        let text: String
    }

    private let lines: [Line]
    private let folderName: String
    private let cardTitle: String
    private let schedule: LapMotion.IntroSchedule

    @State private var start = Date()
    @State private var finished = false
    @Namespace private var flight
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init() {
        let manifest = SampleRecordingStore.manifest(lang: SampleRecordingStore.preferredLang)
        let me: String = manifest?.speakers.me ?? ""
        let them: String = manifest?.speakers.them ?? ""
        let segments: [SampleManifest.Segment] = Array(manifest?.segments.prefix(3) ?? [])
        var built: [Line] = []
        for segment in segments {
            let isMe = segment.speaker == "me"
            built.append(Line(speaker: isMe ? me : them, isMe: isMe, text: LapMotion.clip(segment.text)))
        }
        lines = built
        folderName = manifest?.suggestion?.folders.first?.name ?? ""
        cardTitle = manifest?.suggestion?.title ?? ""
        schedule = LapMotion.introBeats(lineLengths: built.map { $0.text.count })
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: finished || reduceMotion)) { context in
            let t = reduceMotion ? schedule.end : context.date.timeIntervalSince(start)
            VStack(alignment: .leading, spacing: 16) {
                stage(at: t)
                    .frame(maxWidth: .infinity, minHeight: 300, alignment: .topLeading)
                caption(at: t)
            }
            .onChange(of: t >= schedule.end) { _, done in
                if done { finished = true }
            }
        }
        .accessibilityElement(children: .ignore)
        // VoiceOver gets the three points the page used to print, rather than
        // a film it cannot see.
        .accessibilityLabel(
            Text("Record and transcribe live, even from the lock screen") + Text(verbatim: ". ")
                + Text("One customer, one folder, synced with your Mac") + Text(verbatim: ". ")
                + Text("Share to ChatGPT or Claude for analysis"))
    }

    // MARK: the stage

    private func stage(at t: TimeInterval) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            recordingPill(at: t)
            transcript(at: t)
            folder(at: t)
            shareMark(at: t)
        }
    }

    /// (a) Recording: a red dot that blinks, and the clock.
    private func recordingPill(at t: TimeInterval) -> some View {
        let shown = t >= schedule.recording
        let blink = Int((t - schedule.recording) / 0.6) % 2 == 0 || t >= schedule.end
        return HStack(spacing: 8) {
            Circle()
                .fill(Theme.recording)
                .frame(width: 8, height: 8)
                .opacity(blink ? 1 : 0.25)
            Text("Recording now")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Color(.label))
            Text(verbatim: "00:12")
                .font(.parley.footnote.monospacedDigit())
                .foregroundStyle(Color(.secondaryLabel))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .overlay(Capsule().stroke(Color(.separator), lineWidth: 0.5))
        .scaleEffect(shown ? 1 : 0.6, anchor: .leading)
        .opacity(shown ? 1 : 0)
        .animation(LapMotion.spring, value: shown)
    }

    /// (b) Transcript: each line types itself in, then its speaker's name
    /// fades in above it — "you" in the tint, the other side in secondary, as
    /// the live screen marks who is talking.
    private func transcript(at t: TimeInterval) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                let typed = schedule.typedCount(line: index, at: t)
                let named = t >= schedule.lines[index].name
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: line.speaker)
                        .font(.parley.caption.weight(.semibold))
                        .foregroundStyle(line.isMe ? Theme.primary : Color(.secondaryLabel))
                        .opacity(named ? 1 : 0)
                        .animation(.easeOut(duration: 0.4), value: named)
                    // The full line sits under the typed one, invisible, so
                    // the block has its final height from the start and
                    // nothing below it jumps as the words arrive.
                    ZStack(alignment: .topLeading) {
                        Text(verbatim: line.text).opacity(0)
                        Text(verbatim: LapMotion.typed(line.text, count: typed))
                    }
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.label))
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// (c) Filing: the customer's folder slides in; the suggestion card — the
    /// name Parley gave the call — flies into it, and the row flashes once.
    private func folder(at t: TimeInterval) -> some View {
        let shown = t >= schedule.folder
        let landed = t >= schedule.cardFly
        let flashing = landed && t < schedule.cardFly + 0.6
        return VStack(alignment: .leading, spacing: 8) {
            if !landed {
                card
                    .matchedGeometryEffect(id: "card", in: flight)
                    .opacity(shown ? 1 : 0)
            }
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .foregroundStyle(Color(.secondaryLabel))
                Text(verbatim: folderName)
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Color(.label))
                Spacer(minLength: 8)
                if landed {
                    card
                        .matchedGeometryEffect(id: "card", in: flight)
                        .scaleEffect(0.9, anchor: .trailing)
                }
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .fill(Theme.primary.opacity(flashing ? 0.10 : 0)))
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color(.separator)).frame(height: 0.5)
            }
            .offset(x: shown ? 0 : -24)
            .opacity(shown ? 1 : 0)
        }
        .animation(LapMotion.spring, value: shown)
        .animation(LapMotion.spring, value: landed)
        .animation(.easeOut(duration: 0.5), value: flashing)
    }

    private var card: some View {
        Text(verbatim: cardTitle)
            .font(.parley.caption)
            .foregroundStyle(Color(.label))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .stroke(Color(.separator), lineWidth: 0.5))
    }

    /// (d) Hand-off: the share mark fades in, then lights in the tint with a
    /// soft ring.
    private func shareMark(at t: TimeInterval) -> some View {
        let shown = t >= schedule.share - 0.3
        let lit = t >= schedule.share
        return ZStack {
            Circle()
                .stroke(Theme.primary.opacity(lit ? 0.25 : 0), lineWidth: 6)
                .frame(width: 40, height: 40)
                .scaleEffect(lit ? 1 : 0.7)
            Image(systemName: "square.and.arrow.up")
                .font(.parley.title3)
                .foregroundStyle(lit ? Theme.primary : Color(.tertiaryLabel))
        }
        .frame(maxWidth: .infinity)
        .opacity(shown ? 1 : 0)
        .animation(.easeOut(duration: 0.4), value: shown)
        .animation(LapMotion.spring, value: lit)
    }

    // MARK: the caption

    private func caption(at t: TimeInterval) -> some View {
        let beat = schedule.beat(at: t) ?? .recording
        return Text(captionText(beat))
            .font(.parley.subheadline)
            .foregroundStyle(Color(.secondaryLabel))
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .id(beat)
            .transition(.opacity)
            .animation(.easeOut(duration: 0.4), value: beat)
    }

    private func captionText(_ beat: LapMotion.IntroBeat) -> LocalizedStringKey {
        switch beat {
        case .recording: return "Parley records both sides of the conversation."
        case .transcript: return "It turns into text as you go, with who said what."
        case .folder: return "Then one customer, one folder."
        case .share: return "And share it with ChatGPT or Claude to analyse."
        }
    }
}
