import SwiftUI

/// The Parley keyboard's face.
///
/// Two panes under one strip, in the shape dictation keyboards have settled on
/// (Typeless, Wispr Flow): the wordmark and a two-way mode picker on top, then
/// either the dictation pane — a status line, the mic pill with `⌫` and `@`
/// flanking it, and a wide return key — or a full QWERTY plane. A horizontal
/// swipe across the body moves between them, so the picker is a signpost rather
/// than the only way across.
///
/// The view paints no background of its own. The system's `UIInputView` is
/// already the right colour, already has the right corners and already covers
/// exactly the right area; painting over it was what made the keyboard seam
/// against the row below and sit a shade off from the system's.
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
            modeStrip
            pane
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The swipe lives on the pane, not on a key, and demands real
                // travel before it engages — otherwise a fat-fingered tap on
                // `g` would throw the user into the other mode.
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 24)
                        .onEnded { value in
                            let dx = value.translation.width
                            guard abs(dx) > KBMetrics.swipeThreshold,
                                abs(dx) > abs(value.translation.height) * 1.5
                            else { return }
                            select(dx < 0 ? .letters : .voice)
                        }
                )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var pane: some View {
        switch bridge.mode {
        case .voice: voicePane
        case .letters: LetterPane(bridge: bridge, dark: dark)
        }
    }

    private func select(_ mode: KeyboardMode) {
        guard bridge.mode != mode else { return }
        withAnimation(.easeInOut(duration: 0.18)) { bridge.setMode(mode) }
    }

    // MARK: mode strip — wordmark + picker

    private var modeStrip: some View {
        HStack(spacing: 0) {
            Text(verbatim: "Parley")
                .font(.footnote.weight(.bold))
                .foregroundStyle(KBTheme.wordmark(dark))
            Spacer(minLength: 8)
            HStack(spacing: 2) {
                segment(.voice, label: Image(systemName: "waveform"))
                    .accessibilityLabel(Text("Voice dictation"))
                segment(.letters, label: Text(verbatim: "EN"))
                    .accessibilityLabel(Text("English keyboard"))
            }
            .padding(2)
            .background(Capsule().fill(KBTheme.segmentTrack(dark)))
        }
        .frame(height: KBMetrics.strip)
        .padding(.horizontal, 12)
    }

    private func segment<Label: View>(_ mode: KeyboardMode, label: Label) -> some View {
        let selected = bridge.mode == mode
        return PressableButton(action: { select(mode) }) { pressed in
            label
                .font(.footnote.weight(.semibold))
                .foregroundStyle(selected ? KBTheme.ink(dark) : KBTheme.inkSoft(dark))
                .frame(width: 42, height: 26)
                .background(
                    Capsule()
                        .fill(selected ? KBTheme.key(dark) : .clear)
                        .opacity(pressed ? 0.6 : 1))
        }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: the voice pane

    private var voicePane: some View {
        VStack(spacing: KBMetrics.voiceRowSpacing) {
            caption
            // The mic keeps the middle; delete and `@` flank it so the two
            // edits a dictating user actually reaches for — take that back,
            // type an address — never cost a trip through the EN pane.
            HStack(spacing: 10) {
                RepeatingKey(action: { bridge.backspace() }) { pressed in
                    quickCap(pressed: pressed) {
                        Image(systemName: "delete.left")
                            .font(.system(size: 18, weight: .regular))
                    }
                }
                .frame(width: KBMetrics.quickKeyWidth, height: KBMetrics.micHeight)
                .accessibilityLabel(Text("Delete"))

                micPill

                PressableButton(action: { bridge.type("@") }) { pressed in
                    quickCap(pressed: pressed) {
                        Text(verbatim: "@").font(.system(size: 20))
                    }
                }
                .frame(width: KBMetrics.quickKeyWidth, height: KBMetrics.micHeight)
                .accessibilityLabel(Text("At sign"))
            }
            HStack(spacing: 10) {
                // Always here, on every device: Parley ships no Bopomofo
                // engine, so this key is a 注音 user's only way out.
                GlobeKey(controller: bridge.controller, dark: dark)
                    .frame(width: KBMetrics.quickKeyWidth, height: KBMetrics.quickRowHeight)
                PressableButton(action: { bridge.newline() }) { pressed in
                    ZStack {
                        KeyCap(
                            dark: dark, tint: bridge.returnKeyIsAccented ? .accent : .alt,
                            pressed: pressed)
                        Text(bridge.returnKeyLabel)
                            .font(.system(size: 15))
                            .foregroundStyle(
                                bridge.returnKeyIsAccented ? .white : KBTheme.ink(dark))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: KBMetrics.quickRowHeight)
                }
                .accessibilityLabel(Text(bridge.returnKeyLabel))
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, KBMetrics.paneTop)
        .padding(.bottom, KBMetrics.paneBottom)
    }

    private func quickCap<Content: View>(
        pressed: Bool, @ViewBuilder glyph: () -> Content
    ) -> some View {
        ZStack {
            KeyCap(dark: dark, tint: .alt, pressed: pressed)
            glyph().foregroundStyle(KBTheme.ink(dark))
        }
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
        .frame(height: KBMetrics.captionHeight)
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
                .frame(width: KBMetrics.micWidth, height: KBMetrics.micHeight)
                .background(
                    Capsule().fill(micFill).brightness(pressed ? -0.08 : 0))
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(
            bridge.listening
                ? Text("Stop dictation") : Text("Start dictation"))
    }

    /// Idle: Pathors' brand gradient, the one place on the keyboard where
    /// Parley is allowed to look like Parley. Recording: the flat recording red,
    /// so "armed" is never something you have to read out of a gradient.
    /// Disabled (no Full Access): a key-coloured pill so it reads inert.
    private var micFill: AnyShapeStyle {
        if !bridge.hasFullAccess { return AnyShapeStyle(KBTheme.key(dark)) }
        if bridge.listening { return AnyShapeStyle(KBTheme.recording) }
        return AnyShapeStyle(KBTheme.micGradient)
    }

    private var micInk: Color {
        if !bridge.hasFullAccess { return KBTheme.inkSoft(dark) }
        return .white
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
