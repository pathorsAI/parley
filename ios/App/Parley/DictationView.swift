import SwiftUI

/// The hand-off screen shown while a keyboard-triggered dictation is live.
///
/// Deliberately *not* a transcription screen. Dictation is experienced in the
/// keyboard — the transcript streams into the Parley keyboard and lands at the
/// cursor of the app the user was typing in. This screen exists only because
/// the mic has to open in the app process, so the user briefly lands here; its
/// one job is to send them back. Showing a live transcript here taught people
/// the wrong model ("I talk on this screen, then paste"), so it doesn't.
///
/// Two shapes, decided by `coordinator.returnableHost`:
///   - The jump landed (or is in flight): the app is bouncing the user back
///     automatically, so this is only glimpsed in passing.
///   - No jump: the headline is the swipe gesture, and the guide sits at the
///     very bottom, pointing at the real home indicator it wants swiped.
///
/// Which one is *not* a decision about the iOS version any more. The app tries
/// the jump and watches whether it worked, so this screen can start in the
/// first shape and fall back to the second about a second later — see
/// `HostReturnPolicy` for why that is the right way round.
struct DictationView: View {
    @ObservedObject var coordinator = DictationCoordinator.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The user is stranded here and has to swipe back themselves. Never while
    /// the microphone prompt is up: swiping away would cancel the prompt as a
    /// refusal, and the guidance was actively steering people into doing so.
    private var needsManualReturn: Bool {
        !coordinator.awaitingMicPermission
            && coordinator.returnableHost == nil
            && (coordinator.state == .starting || coordinator.state == .listening
                || coordinator.state == .reconnecting)
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            status
            Spacer()
            footer
        }
        .frame(maxWidth: .infinity)
        .background(Theme.background)
    }

    // MARK: status — icon + the one instruction

    private var status: some View {
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
                .font(.parley.title3)
                .foregroundStyle(Theme.foreground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Text(statusSubtitle)
                .font(.parley.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 32)
        }
    }

    private var pulse: CGFloat {
        coordinator.state == .listening || coordinator.state == .reconnecting ? 1.06 : 1
    }

    private var statusIcon: String {
        switch coordinator.state {
        case .error: return "exclamationmark.triangle"
        case .finishing, .done: return "checkmark"
        // Deliberately not the warning triangle: the microphone is still open
        // and the words are being kept. This is a pause, not a failure.
        case .reconnecting: return "arrow.triangle.2.circlepath"
        default: return "waveform"
        }
    }

    /// The headline is whatever the user must do next. Stranded here, that is
    /// the swipe back — "Listening…" would be answering the wrong question.
    private var statusTitle: String {
        if coordinator.awaitingMicPermission {
            return String(localized: "Allow microphone access")
        }
        // Ahead of the swipe guidance: a user watching this screen while it
        // redials should be told what it is doing, not asked to leave.
        if coordinator.state == .reconnecting {
            return String(localized: "Reconnecting…")
        }
        if needsManualReturn {
            return String(localized: "Swipe back to your app")
        }
        switch coordinator.state {
        case .starting: return String(localized: "Getting ready…")
        case .listening: return String(localized: "Listening…")
        case .finishing: return String(localized: "Wrapping up…")
        case .done: return String(localized: "Done")
        case .error: return String(localized: "Couldn't start")
        // Handled above, before the swipe guidance.
        case .reconnecting: return String(localized: "Reconnecting…")
        }
    }

    private var statusSubtitle: String {
        if coordinator.awaitingMicPermission {
            return String(
                localized:
                    "Parley records here and types your words at the cursor. Answer the prompt first — dictation can't start without it."
            )
        }
        if coordinator.state == .error {
            return coordinator.errorMessage ?? String(localized: "Please try again.")
        }
        if coordinator.state == .reconnecting {
            return String(
                localized:
                    "Keep talking — the microphone is still on and what you say is kept until the connection is back."
            )
        }
        if needsManualReturn {
            return String(
                localized:
                    "Your words show up on the Parley keyboard as you talk, and land at the cursor when you stop — nothing happens on this screen."
            )
        }
        return String(localized: "You're back in your app — just talk.")
    }

    // MARK: footer — only the swipe guide, hugging the home indicator

    /// No stop control here on purpose: stopping (like everything else about
    /// dictation) belongs to the keyboard's red ⏹. This screen never competes
    /// with the keyboard for the session — its whole vocabulary is "go back".
    private var footer: some View {
        VStack(spacing: 14) {
            // Last element on the screen, right above the real home indicator,
            // and shown on every stranded session — a gesture nobody has ever
            // performed isn't learned from one viewing.
            if needsManualReturn {
                SwipeBackGuide(animated: !reduceMotion)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }
}

/// The one gesture that replaces auto-return on iOS 26.4+: an arrow sweeping
/// right across a stand-in for the home indicator, drawn directly above the
/// real one so the guide points at the thing it means.
private struct SwipeBackGuide: View {
    let animated: Bool
    @State private var go = false

    var body: some View {
        VStack(spacing: 12) {
            Text("Swipe right on the bar below")
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Theme.foreground)
            ZStack(alignment: .leading) {
                // `border`, not `muted`: the card underneath is now
                // `tintedSurface`, and in light mode the two are the same pale
                // blue — the stand-in home indicator would vanish into it.
                Capsule()
                    .fill(Theme.border)
                    .frame(height: 5)
                    .frame(maxWidth: .infinity)
                Image(systemName: "arrow.right")
                    .font(.parley.footnote.weight(.bold))
                    .foregroundStyle(Theme.primary)
                    .offset(x: go ? 150 : 0)
                    .opacity(go ? 0 : 1)
                    .animation(
                        animated
                            ? .easeInOut(duration: 1.1).repeatForever(autoreverses: false)
                            : nil,
                        value: go)
            }
            .frame(height: 20)
            .frame(maxWidth: 220)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius)
                .fill(Theme.tintedSurface))
        .onAppear { if animated { go = true } }
    }
}
