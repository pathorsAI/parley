import SwiftUI

/// The Parley keyboard's face. Deliberately spare: a big dictation control, a
/// one-line preview of what the app is hearing, and a minimal key row so the
/// keyboard still does something useful without Full Access (App Review 4.4.1).
struct KeyboardRootView: View {
    @ObservedObject var bridge: KeyboardBridge
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 10) {
            if bridge.hasFullAccess {
                dictationArea
            } else {
                fullAccessNotice
            }
            keyRow
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .frame(height: 216)
    }

    // MARK: dictation

    private var dictationArea: some View {
        VStack(spacing: 8) {
            Text(bridge.listening ? preview : String(localized: "Tap the mic and talk — your words land right here"))
                .font(.callout)
                .foregroundStyle(bridge.listening ? Color.primary : Color.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .center)
                .padding(.horizontal, 10)

            Button(action: toggle) {
                HStack(spacing: 10) {
                    Image(systemName: bridge.listening ? "stop.fill" : "mic.fill")
                        .font(.title3)
                    Text(bridge.listening ? "Stop" : "Voice typing")
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(bridge.listening ? Color.red : Color.accentColor))
            }
            .buttonStyle(.plain)
        }
    }

    private var preview: String {
        bridge.partial.isEmpty ? String(localized: "Listening…") : bridge.partial
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

    private var fullAccessNotice: some View {
        VStack(spacing: 6) {
            Image(systemName: "mic.slash")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Voice typing needs Full Access")
                .font(.callout.weight(.medium))
            Text(
                "Settings › General › Keyboard › Parley, then turn on Allow Full Access. Your voice goes to your Parley account to be transcribed, which is why it's needed."
            )
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
        }
        .frame(maxWidth: .infinity, minHeight: 96)
    }

    // MARK: minimal keys — keeps the keyboard functional without Full Access

    private var keyRow: some View {
        HStack(spacing: 6) {
            key(system: "globe") { bridge.nextKeyboard() }
            key(text: "space", wide: true) { bridge.space() }
            key(system: "return") { bridge.newline() }
            key(system: "delete.left") { bridge.backspace() }
        }
        .frame(height: 46)
    }

    private func key(
        text: String? = nil, system: String? = nil, wide: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Group {
                if let system { Image(systemName: system) }
                else { Text(text ?? "") }
            }
            .font(.body)
            .foregroundStyle(Color.primary)
            .frame(maxWidth: wide ? .infinity : 52, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.secondarySystemBackground)))
        }
        .buttonStyle(.plain)
    }
}
