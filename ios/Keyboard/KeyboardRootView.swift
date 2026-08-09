import SwiftUI

/// The Parley keyboard's face: a status line that shows the session is alive, a
/// preview of the words not yet inserted, one large dictation control, and a
/// minimal key row so the keyboard still types without Full Access (App Review
/// 4.4.1).
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
        VStack(spacing: 8) {
            if bridge.hasFullAccess {
                dictationArea
            } else {
                fullAccessNotice
            }
            keyRow
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(KBTheme.canvas(dark))
    }

    // MARK: dictation

    private var dictationArea: some View {
        VStack(spacing: 8) {
            statusLine
            preview
            micButton
        }
    }

    /// A live indicator beats a static word: three bars that keep moving say the
    /// app on the other side of the App Group is still listening, which is the
    /// one thing a person cannot otherwise tell from inside another app.
    private var statusLine: some View {
        HStack(spacing: 7) {
            if bridge.listening {
                PulseBars(color: KBTheme.accent)
                Text("Listening…")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(KBTheme.accent)
            } else {
                Image(systemName: "mic")
                    .font(.caption)
                    .foregroundStyle(KBTheme.inkSoft(dark))
                Text("Tap to talk — your words land at the cursor")
                    .font(.caption)
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
        }
        .frame(height: 16)
        .animation(.easeInOut(duration: 0.2), value: bridge.listening)
    }

    /// The tentative tail — the words the app has heard but not yet settled.
    /// Settled text is already in the document, so echoing it here would only
    /// duplicate what the person can see behind the keyboard.
    private var preview: some View {
        Text(bridge.partial.isEmpty ? " " : bridge.partial)
            .font(.callout)
            .foregroundStyle(KBTheme.ink(dark).opacity(0.75))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(height: 52)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(KBTheme.well(dark)))
            .padding(.horizontal, 4)
            .animation(.easeOut(duration: 0.15), value: bridge.partial)
    }

    private var micButton: some View {
        PressableButton(action: toggle) { pressed in
            HStack(spacing: 9) {
                Image(systemName: bridge.listening ? "stop.fill" : "mic.fill")
                    .font(.system(size: 17, weight: .semibold))
                Text(bridge.listening ? "Stop" : "Voice typing")
                    .font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(bridge.listening ? KBTheme.recording : KBTheme.accent)
                    .brightness(pressed ? -0.08 : 0))
        }
        .padding(.horizontal, 4)
    }

    private func toggle() {
        if bridge.listening {
            bridge.stop()
        } else if let url = bridge.prepare() {
            // SwiftUI's openURL is the path that still opens the container app
            // from a keyboard on iOS 18+. If the system declines, fall back to
            // the responder-chain walk for older releases.
            openURL(url) { accepted in
                if !accepted { bridge.fallbackOpen(url) }
            }
        }
    }

    // MARK: no Full Access

    /// Without Full Access the keyboard has no network and no App Group, so
    /// dictation cannot run. The key row below still types — the keyboard is
    /// never a dead brick — and this explains the one switch that unlocks it.
    private var fullAccessNotice: some View {
        VStack(spacing: 5) {
            Image(systemName: "mic.slash")
                .font(.title3)
                .foregroundStyle(KBTheme.inkSoft(dark))
            Text("Voice typing needs Full Access")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KBTheme.ink(dark))
            Text("Settings › General › Keyboard › Keyboards › Parley → Allow Full Access. Your voice is sent to your Parley account to be transcribed.")
                .font(.caption)
                .foregroundStyle(KBTheme.inkSoft(dark))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: minimal keys — keeps the keyboard functional without Full Access

    private var keyRow: some View {
        HStack(spacing: 6) {
            key(system: "globe", width: 46) { bridge.nextKeyboard() }
            key(text: "space", wide: true) { bridge.space() }
            key(system: "return", width: 60) { bridge.newline() }
            key(system: "delete.left", width: 46) { bridge.backspace() }
        }
        .frame(height: 44)
        .padding(.horizontal, 3)
    }

    private func key(
        text: String? = nil, system: String? = nil,
        width: CGFloat? = nil, wide: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        PressableButton(action: action) { pressed in
            Group {
                if let system {
                    Image(systemName: system).font(.system(size: 18, weight: .regular))
                } else {
                    Text(text ?? "").font(.system(size: 15))
                }
            }
            .foregroundStyle(KBTheme.ink(dark))
            .frame(maxWidth: wide ? .infinity : width, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(pressed ? KBTheme.keyPressed(dark) : KBTheme.key(dark))
                    .shadow(color: .black.opacity(dark ? 0 : 0.28), radius: 0, x: 0, y: 1))
        }
        .frame(maxWidth: wide ? .infinity : width)
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
