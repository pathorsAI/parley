import SwiftUI

/// The Parley keyboard's face, in the shape dictation keyboards have settled
/// on (Typeless, Wispr Flow): a brand mark and a delete key on top, one large
/// mic pill in the middle under a short status caption, and a minimal
/// space/return/globe row at the bottom so the keyboard still types without
/// Full Access (App Review 4.4.1).
///
/// Everything here is presentation only — no audio, no transcript history — so
/// the extension stays well under the jetsam limit keyboard processes run
/// against.
struct KeyboardRootView: View {
    @ObservedObject var bridge: KeyboardBridge
    @Environment(\.openURL) private var openURL

    /// The host field's appearance, not the system's: a dark-themed app puts a
    /// dark keyboard on screen even in light mode.
    var dark: Bool

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 6)
            caption
            Spacer(minLength: 12)
            micPill
            Spacer(minLength: 12)
            // Only devices without the system's own input switcher (next to
            // the home indicator) get a globe here — everyone else already has
            // one right below the keyboard, and a second would be noise.
            if bridge.needsGlobe {
                HStack {
                    circleKey(system: "globe") { bridge.nextKeyboard() }
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(KBTheme.canvas(dark))
    }

    // MARK: top bar — brand + delete

    private var topBar: some View {
        HStack {
            HStack(spacing: 5) {
                Image(systemName: "waveform")
                    .font(.footnote.weight(.semibold))
                Text(verbatim: "Parley")
                    .font(.footnote.weight(.semibold))
            }
            .foregroundStyle(KBTheme.inkSoft(dark))
            Spacer()
            circleKey(system: "delete.left") { bridge.backspace() }
        }
        .frame(height: 38)
    }

    // MARK: caption — the state line above the mic

    /// One fixed-height slot so the layout never jumps between states: the
    /// Full Access explainer, the idle prompt, the listening indicator, or the
    /// tentative tail (the words heard but not yet settled — settled text is
    /// already in the document behind the keyboard, so it is never echoed).
    private var caption: some View {
        Group {
            if !bridge.hasFullAccess {
                VStack(spacing: 3) {
                    Text("Voice typing needs Full Access")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(KBTheme.ink(dark))
                    Text("Settings › General › Keyboard › Keyboards › Parley → Allow Full Access. Your voice is sent to your Parley account to be transcribed.")
                        .font(.caption2)
                        .foregroundStyle(KBTheme.inkSoft(dark))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 12)
                }
            } else if let error = bridge.errorText, !bridge.listening {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(KBTheme.recording)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
            } else if bridge.listening && !bridge.partial.isEmpty {
                Text(bridge.partial)
                    .font(.callout)
                    .foregroundStyle(KBTheme.ink(dark).opacity(0.8))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
            } else if bridge.listening {
                HStack(spacing: 7) {
                    PulseBars(color: KBTheme.recording)
                    Text("Listening…")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(KBTheme.recording)
                }
            } else {
                Text("Tap to speak")
                    .font(.subheadline)
                    .foregroundStyle(KBTheme.inkSoft(dark))
            }
        }
        .frame(height: 48)
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.15), value: bridge.listening)
        .animation(.easeOut(duration: 0.15), value: bridge.partial)
    }

    // MARK: the mic pill

    private var micPill: some View {
        PressableButton(action: toggle) { pressed in
            Image(systemName: bridge.listening ? "stop.fill" : "mic.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(micInk)
                .frame(width: 150, height: 52)
                .background(
                    Capsule().fill(micFill).brightness(pressed ? -0.08 : 0))
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(
            bridge.listening
                ? Text("Stop dictation") : Text("Start dictation"))
    }

    /// Idle: the Typeless-style ink pill — near-black on a light canvas, white
    /// on a dark one. Recording: the shared recording red. Disabled (no Full
    /// Access): a key-colored pill so it reads inert.
    private var micFill: Color {
        if !bridge.hasFullAccess { return KBTheme.key(dark) }
        if bridge.listening { return KBTheme.recording }
        return dark ? .white : Color(white: 0.10)
    }

    private var micInk: Color {
        if !bridge.hasFullAccess { return KBTheme.inkSoft(dark) }
        if bridge.listening { return .white }
        return dark ? Color(white: 0.10) : .white
    }

    private func toggle() {
        if bridge.listening {
            bridge.stop()
        } else {
            // The bridge tries the no-jump start first; the completion only
            // fires when the app really has to come forward. SwiftUI's openURL
            // is the path that still opens the container app from a keyboard
            // on iOS 18+; the responder-chain walk covers older releases.
            bridge.start { url in
                guard let url else { return }
                openURL(url) { accepted in
                    if !accepted { bridge.fallbackOpen(url) }
                }
            }
        }
    }

    // MARK: key shapes

    private func circleKey(system: String, action: @escaping () -> Void) -> some View {
        PressableButton(action: action) { pressed in
            Image(systemName: system)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(KBTheme.ink(dark))
                .frame(width: 44, height: 38)
                .background(
                    Capsule()
                        .fill(pressed ? KBTheme.keyPressed(dark) : KBTheme.key(dark))
                        .shadow(
                            color: .black.opacity(dark ? 0 : 0.28),
                            radius: 0, x: 0, y: 1))
        }
    }
}

/// A button that reports its own pressed state, so keys and the mic control can
/// darken under the finger the way system keys do. `.buttonStyle(.plain)` alone
/// gives no feedback at all, which is what made the keys feel dead.
private struct PressableButton<Content: View>: View {
    let action: () -> Void
    @ViewBuilder var content: (Bool) -> Content

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(PressStyle(content: content))
    }

    private struct PressStyle<C: View>: ButtonStyle {
        @ViewBuilder var content: (Bool) -> C
        func makeBody(configuration: Configuration) -> some View {
            content(configuration.isPressed)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
        }
    }
}

/// Three bars that keep breathing while the app is listening. Deliberately not
/// a level meter: the audio lives in the container app, and streaming real
/// levels across the App Group at frame rate would cost far more than the
/// reassurance is worth. It says "still running", and nothing it can't know.
private struct PulseBars: View {
    let color: Color
    @State private var animating = false

    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(0..<3, id: \.self) { i in
                Capsule()
                    .fill(color)
                    .frame(width: 2.5, height: animating ? 12 : 4)
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever()
                            .delay(Double(i) * 0.15),
                        value: animating)
            }
        }
        .frame(height: 14)
        .onAppear { animating = true }
    }
}
