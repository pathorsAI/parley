import SwiftUI

/// The screen the app shows while a keyboard-triggered dictation is live.
///
/// Two shapes, decided by `HostReturn.canReturn`:
///   - Older iOS: the app has already bounced the user back to their app, so
///     this is only seen briefly (or if they switch back to Parley). It shows
///     the live transcript and a stop control.
///   - iOS 26.4+: the automatic jump-back is gone, so this screen owns the
///     hand-off — it teaches the one gesture that replaces it (swipe right on
///     the home bar) and reassures that talking still works from the other app.
struct DictationView: View {
    @ObservedObject var coordinator = DictationCoordinator.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("dictationSwipeGuideSeen") private var guideSeen = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.border)
            transcript
            Divider().overlay(Theme.border)
            footer
        }
        .background(Theme.background)
        .onDisappear { guideSeen = true }
    }

    // MARK: header — state + level

    private var header: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Theme.recording.opacity(0.15))
                    .frame(width: 84, height: 84)
                    .scaleEffect(pulse)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(),
                        value: coordinator.micLevel)
                Circle()
                    .fill(Theme.recording.opacity(0.28))
                    .frame(width: 84 * CGFloat(1 + min(0.6, coordinator.micLevel * 4)))
                    .animation(.linear(duration: 0.08), value: coordinator.micLevel)
                Image(systemName: statusIcon)
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(Theme.recording)
            }
            .frame(height: 120)
            .accessibilityHidden(true)

            Text(statusTitle)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.foreground)
            Text(statusSubtitle)
                .font(.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
        .padding(.bottom, 24)
    }

    private var pulse: CGFloat {
        coordinator.state == .listening ? 1.06 : 1
    }

    private var statusIcon: String {
        switch coordinator.state {
        case .error: return "exclamationmark.triangle"
        case .finishing, .done: return "checkmark"
        default: return "waveform"
        }
    }

    private var statusTitle: String {
        switch coordinator.state {
        case .starting: return String(localized: "Getting ready…")
        case .listening: return String(localized: "Listening…")
        case .finishing: return String(localized: "Wrapping up…")
        case .done: return String(localized: "Done")
        case .error: return String(localized: "Couldn't start")
        }
    }

    private var statusSubtitle: String {
        if coordinator.state == .error {
            return coordinator.errorMessage ?? String(localized: "Please try again.")
        }
        // The manual hand-off only matters while the app is actually the thing
        // on screen, i.e. when auto-return didn't (or couldn't) fire.
        if coordinator.returnableHost == nil {
            return String(
                localized:
                    "Speak and the words go straight into the field you were typing in. Swipe right on the home bar to get back to that app."
            )
        }
        return String(localized: "You're back in your app — just talk.")
    }

    // MARK: transcript preview

    private var transcript: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if coordinator.committed.isEmpty && coordinator.partial.isEmpty {
                    Text("Waiting for you to speak…")
                        .font(.body)
                        .foregroundStyle(Theme.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 20)
                } else {
                    (Text(coordinator.committed).foregroundStyle(Theme.foreground)
                        + Text(coordinator.partial).foregroundStyle(Theme.mutedForeground))
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(20)
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: footer — swipe guide + stop

    private var footer: some View {
        VStack(spacing: 16) {
            if coordinator.returnableHost == nil && !guideSeen
                && coordinator.state == .listening
            {
                SwipeBackGuide(animated: !reduceMotion)
            }
            Button {
                Task {
                    await coordinator.stop()
                    await coordinator.dismiss()
                }
            } label: {
                Label(
                    coordinator.state == .listening ? "Stop and insert" : "Done",
                    systemImage: "stop.circle.fill"
                )
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .foregroundStyle(.white)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.recording)
        }
        .padding(20)
    }
}

/// The one gesture that replaces auto-return on iOS 26.4+: an arrow sweeping
/// right across a stand-in for the home indicator. Loops until the user has
/// seen it once.
private struct SwipeBackGuide: View {
    let animated: Bool
    @State private var go = false

    var body: some View {
        VStack(spacing: 10) {
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.muted)
                    .frame(height: 5)
                    .frame(maxWidth: .infinity)
                Image(systemName: "arrow.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Theme.primary)
                    .offset(x: go ? 120 : 0)
                    .animation(
                        animated
                            ? .easeInOut(duration: 1.1).repeatForever(autoreverses: false)
                            : nil,
                        value: go)
            }
            .frame(height: 20)
            .frame(maxWidth: 180)
            Text("Swipe right to go back")
                .font(.caption)
                .foregroundStyle(Theme.mutedForeground)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius)
                .fill(Theme.card))
        .onAppear { if animated { go = true } }
    }
}
