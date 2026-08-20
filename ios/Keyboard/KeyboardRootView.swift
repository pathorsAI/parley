import SwiftUI

/// The Parley keyboard's face.
///
/// Two panes under one strip: the voice pane — a live-transcript slot, one
/// round record button and the three controls a dictating user reaches for —
/// or a full QWERTY plane. The panes sit side by side on a track that follows
/// the finger, so a horizontal drag moves between them and the strip's dots are
/// a signpost rather than the only way across.
///
/// The voice pane is drawn as a **control panel, not a keyboard**. Nothing on
/// it types a letter, so it borrows none of UIKit's key-cap treatment: flat
/// translucent discs, no shadows, and one colour — the record button. Filling
/// the pane with caps (which it used to do) made it read as a broken keyboard
/// rather than a place to speak.
///
/// The view paints no background of its own. The system's `UIInputView` is
/// already the right colour, already has the right corners and already covers
/// exactly the right area; painting over it was what made the keyboard seam
/// against the row below and sit a shade off from the system's.
///
/// Everything here is presentation only — no audio, no transcript history
/// beyond the short tail shown above the button — so the extension stays well
/// under the jetsam limit keyboard processes run against.
struct KeyboardRootView: View {
    @ObservedObject var bridge: KeyboardBridge
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host field's appearance, not the system's: a dark-themed app puts a
    /// dark keyboard on screen even in light mode.
    var dark: Bool

    /// Live horizontal travel of the pane track while a drag is in flight.
    @GestureState private var drag: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            modeStrip
            GeometryReader { geo in
                let width = geo.size.width
                HStack(spacing: 0) {
                    voicePane.frame(width: width)
                    LetterPane(bridge: bridge, dark: dark).frame(width: width)
                }
                .frame(width: width * 2, alignment: .leading)
                // Follow the finger. Both panes are the same height now, so the
                // track can slide without the keyboard resizing under it. The
                // old gesture only committed on release, so nothing moved while
                // the finger did — which is why nobody found the swipe.
                .offset(x: (bridge.mode == .voice ? 0 : -width) + drag)
                .animation(.interactiveSpring(response: 0.32, dampingFraction: 0.86), value: bridge.mode)
                // The gesture lives on the track, not on a key, and demands
                // real travel before it engages — otherwise a fat-fingered tap
                // on `g` would throw the user into the other mode.
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 24)
                        .updating($drag) { value, state, _ in
                            state = rubberBanded(value.translation.width, width: width)
                        }
                        .onEnded { value in
                            let dx = value.translation.width
                            guard abs(dx) > KBMetrics.swipeThreshold,
                                abs(dx) > abs(value.translation.height) * 1.5
                            else { return }
                            select(dx < 0 ? .letters : .voice)
                        }
                )
            }
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Resist a drag that would pull the track past either end, so the pane
    /// never detaches from the edge of the keyboard.
    private func rubberBanded(_ dx: CGFloat, width: CGFloat) -> CGFloat {
        let overshoot = (bridge.mode == .voice && dx > 0) || (bridge.mode == .letters && dx < 0)
        return overshoot ? dx / 4 : max(-width, min(width, dx))
    }

    private func select(_ mode: KeyboardMode) {
        guard bridge.mode != mode else { return }
        bridge.setMode(mode)
    }

    // MARK: mode strip — wordmark + where you are

    /// The wordmark, and the current pane named next to two dots.
    ///
    /// It used to be a segmented control, which read as the *only* way across
    /// and hid the fact that the pane swipes at all. Dots say "there is another
    /// one of these, sideways" — and they stay tappable, so nothing is lost.
    private var modeStrip: some View {
        HStack(spacing: 0) {
            Text(verbatim: "Parley")
                .font(.footnote.weight(.bold))
                .foregroundStyle(KBTheme.wordmark(dark))
            Spacer(minLength: 8)
            Text(bridge.mode == .voice ? "Voice" : "Keyboard")
                .font(.caption.weight(.medium))
                .foregroundStyle(KBTheme.inkSoft(dark))
                .padding(.trailing, 8)
                .accessibilityHidden(true)
            HStack(spacing: 5) {
                dot(.voice, label: Text("Voice dictation"))
                dot(.letters, label: Text("English keyboard"))
            }
        }
        .frame(height: KBMetrics.strip)
        .padding(.horizontal, 12)
    }

    private func dot(_ mode: KeyboardMode, label: Text) -> some View {
        let selected = bridge.mode == mode
        return Button(action: { select(mode) }) {
            Capsule()
                .fill(selected ? KBTheme.accent : KBTheme.inkSoft(dark).opacity(0.35))
                .frame(width: selected ? 14 : 5, height: 5)
                // Keep a finger-sized target around a deliberately small mark.
                .contentShape(Rectangle().inset(by: -12))
                .animation(.easeInOut(duration: 0.2), value: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: the voice pane

    private var voicePane: some View {
        VStack(spacing: KBMetrics.textToDeck) {
            textSlot
            deck
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, KBMetrics.voiceSide)
        .padding(.top, KBMetrics.voiceTop)
        .padding(.bottom, KBMetrics.voiceBottom)
    }

    /// The controls, arranged around the record button rather than in a row:
    /// delete top-right, return under it, `@` bottom-left. Top-left is left
    /// empty on purpose — it is where the pane breathes, and it is the slot the
    /// globe takes on the devices that still need one.
    private var deck: some View {
        HStack(spacing: 0) {
            VStack(spacing: KBMetrics.deckRowGap) {
                if bridge.showsGlobe {
                    atKey
                } else {
                    Color.clear.frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
                }
                if bridge.showsGlobe {
                    // Bottom-left, where the system's own globe sits, so the
                    // muscle memory carries over on the devices that show it.
                    GlobeKey(controller: bridge.controller, dark: dark, round: true)
                        .frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
                } else {
                    atKey
                }
            }
            Spacer(minLength: 0)
            recordButton
            Spacer(minLength: 0)
            VStack(spacing: KBMetrics.deckRowGap) {
                deleteKey
                returnKey
            }
        }
        .frame(height: KBMetrics.deckHeight)
    }

    // MARK: the round controls

    private var atKey: some View {
        PressableButton(action: { bridge.type("@") }) { pressed in
            disc(pressed: pressed, quiet: true) {
                Text(verbatim: "@").font(.system(size: 18))
            }
        }
        .accessibilityLabel(Text("At sign"))
    }

    private var deleteKey: some View {
        RepeatingKey(action: { bridge.backspace() }) { pressed in
            disc(pressed: pressed) {
                Image(systemName: "delete.left").font(.system(size: 17))
            }
        }
        .accessibilityLabel(Text("Delete"))
    }

    /// Return, as a glyph rather than a word.
    ///
    /// The host decides what this key is *called* — Go, Send, Search — and a
    /// 44pt disc has no room for "Search". A glyph is the better trade twice
    /// over: it is legible at this size where five letters would not be, and it
    /// keeps the pane's single colour on the record button. What the key
    /// actually does never changes; see `KeyboardBridge.newline()`.
    private var returnKey: some View {
        PressableButton(action: { bridge.newline() }) { pressed in
            disc(pressed: pressed) {
                Image(systemName: bridge.returnKeyGlyph).font(.system(size: 17))
            }
        }
        .accessibilityLabel(Text(bridge.returnKeyLabel))
    }

    private func disc<Content: View>(
        pressed: Bool, quiet: Bool = false, @ViewBuilder glyph: () -> Content
    ) -> some View {
        ZStack {
            ControlDisc(dark: dark, pressed: pressed)
            glyph().foregroundStyle(quiet ? KBTheme.inkSoft(dark) : KBTheme.ink(dark))
        }
        .frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
    }

    // MARK: the record button

    /// The one thing on this pane with a colour: idle it carries Pathors' brand
    /// gradient, listening it goes flat recording red inside a breathing ring,
    /// so "armed" is never something you have to read out of a gradient — and
    /// never needs a second element saying "Listening…" beside it.
    private var recordButton: some View {
        PressableButton(action: toggle) { pressed in
            ZStack {
                if bridge.listening && !reduceMotion {
                    PulseRing(color: KBTheme.recording)
                }
                Circle()
                    .fill(recordFill)
                    .frame(width: KBMetrics.recordSize, height: KBMetrics.recordSize)
                    .brightness(pressed ? -0.06 : 0)
                Image(systemName: bridge.listening ? "stop.fill" : "mic.fill")
                    .font(.system(size: bridge.listening ? 24 : 28, weight: .medium))
                    .foregroundStyle(recordInk)
            }
            .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(
            bridge.listening ? Text("Stop dictation") : Text("Start dictation"))
    }

    /// Disabled (no Full Access) reads inert rather than inviting: the button
    /// can't record until the user has been through Settings.
    private var recordFill: AnyShapeStyle {
        if !bridge.hasFullAccess { return AnyShapeStyle(KBTheme.control(dark)) }
        if bridge.listening { return AnyShapeStyle(KBTheme.recording) }
        return AnyShapeStyle(KBTheme.micGradient)
    }

    private var recordInk: Color {
        bridge.hasFullAccess ? .white : KBTheme.inkSoft(dark)
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

    // MARK: the text slot

    /// One fixed-height slot above the button, so the keyboard never changes
    /// shape between states: the Full Access explainer, an error, the live
    /// transcript, or the idle prompt.
    ///
    /// The live case shows the settled tail in a softer ink followed by the
    /// words not yet settled. Settled text has already been inserted into the
    /// document, but the document is usually behind the keyboard — echoing a
    /// short tail is what makes dictation read as continuous instead of as
    /// words that appear and then vanish.
    private var textSlot: some View {
        Group {
            if !bridge.hasFullAccess {
                fullAccessNotice
            } else if let error = bridge.errorText, !bridge.listening {
                centered {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(KBTheme.recording)
                        .multilineTextAlignment(.center)
                }
            } else if bridge.reconnecting {
                reconnectingText
            } else if bridge.listening || !bridge.tail.isEmpty {
                liveText
            } else {
                centered {
                    Text("Tap to speak")
                        .font(.subheadline)
                        .foregroundStyle(KBTheme.inkSoft(dark))
                }
            }
        }
        .frame(height: KBMetrics.textHeight)
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.15), value: bridge.listening)
        .animation(.easeInOut(duration: 0.15), value: bridge.reconnecting)
        .animation(.easeOut(duration: 0.12), value: bridge.partial)
    }

    /// The connection dropped mid-sentence. The transcript stays exactly where
    /// it was — nothing typed is taken back — with one line above it saying
    /// why it stopped growing. Amber rather than the error red: the session is
    /// still alive and the words are being kept.
    private var reconnectingText: some View {
        VStack(alignment: .leading, spacing: 2) {
            Spacer(minLength: 0)
            Text("Reconnecting… keep talking")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(KBTheme.reconnecting)
            Text(bridge.tail)
                .font(.system(size: 15))
                .foregroundStyle(KBTheme.inkSoft(dark))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var liveText: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            (Text(bridge.tail).foregroundStyle(KBTheme.inkSoft(dark))
                + Text(bridge.tail.isEmpty || bridge.partial.isEmpty ? "" : " ")
                + Text(bridge.partial).foregroundStyle(KBTheme.ink(dark)))
                .font(.system(size: 15))
                .lineLimit(3)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var fullAccessNotice: some View {
        VStack(spacing: 3) {
            Spacer(minLength: 0)
            Text("Voice typing needs Full Access")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KBTheme.ink(dark))
            Text("Settings › General › Keyboard › Keyboards › Parley → Allow Full Access. Your voice is sent to your Parley account to be transcribed.")
                .font(.caption2)
                .foregroundStyle(KBTheme.inkSoft(dark))
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
        }
    }

    private func centered<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack {
            Spacer(minLength: 0)
            content()
            Spacer(minLength: 0)
        }
    }
}

/// Two rings breathing outwards from the record button while the app is
/// listening. Deliberately not a level meter: the audio lives in the container
/// app, and streaming real levels across the App Group at frame rate would cost
/// far more than the reassurance is worth. It says "still running", and nothing
/// it can't know — which is also why it replaced the old "Listening…" caption
/// rather than joining it.
private struct PulseRing: View {
    let color: Color
    @State private var animating = false

    var body: some View {
        ZStack {
            ring(delay: 0)
            ring(delay: 0.6)
        }
        .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        .allowsHitTesting(false)
        .onAppear { animating = true }
    }

    private func ring(delay: Double) -> some View {
        Circle()
            .fill(color.opacity(animating ? 0 : 0.30))
            .frame(width: KBMetrics.recordSize, height: KBMetrics.recordSize)
            .scaleEffect(animating ? 1.25 : 1)
            .animation(
                .easeOut(duration: 1.2).repeatForever(autoreverses: false).delay(delay),
                value: animating)
    }
}
