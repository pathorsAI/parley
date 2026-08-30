import ParleyKit
import SwiftUI

/// The Parley keyboard's face.
///
/// N panes under one strip: the voice pane — a live-transcript slot, one round
/// record button and the three controls a dictating user reaches for — followed
/// by the typing keyboards the user has enabled, QWERTY and 注音. The panes sit
/// side by side on a track that follows the finger, so a horizontal drag moves
/// one pane either way and the strip's dots are a signpost rather than the only
/// way across.
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
                    ForEach(bridge.panes, id: \.self) { pane in
                        paneView(pane).frame(width: width)
                    }
                }
                .frame(width: width * CGFloat(bridge.panes.count), alignment: .leading)
                // Follow the finger. Every pane is the same height, so the
                // track can slide without the keyboard resizing under it. The
                // old gesture only committed on release, so nothing moved while
                // the finger did — which is why nobody found the swipe.
                .offset(x: -width * CGFloat(bridge.paneIndex) + drag)
                .animation(
                    .interactiveSpring(response: 0.32, dampingFraction: 0.86), value: bridge.pane)
                // The gesture lives on the track, not on a key, and demands
                // real travel before it engages — otherwise a fat-fingered tap
                // on `g` would throw the user into the next pane.
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 24)
                        .updating($drag) { value, state, _ in
                            state = rubberBanded(value.translation.width, width: width)
                        }
                        .onEnded { value in
                            // Either measure may commit it: how far the finger
                            // actually went, or where its velocity says it was
                            // going. Reading only the first is what made a fast
                            // flick — the gesture everybody actually uses — do
                            // nothing, because the finger leaves the glass long
                            // before it has travelled 56pt.
                            let move: CGSize
                            if abs(value.translation.width) > KBMetrics.swipeThreshold {
                                move = value.translation
                            } else if abs(value.predictedEndTranslation.width)
                                > KBMetrics.swipeThreshold
                            {
                                move = value.predictedEndTranslation
                            } else {
                                return
                            }
                            // Still has to be a sideways gesture, judged on
                            // whichever measure committed it.
                            guard abs(move.width) > abs(move.height) * 1.5 else { return }
                            bridge.stepPane(by: move.width < 0 ? 1 : -1)
                        }
                )
            }
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func paneView(_ pane: KeyboardPane) -> some View {
        switch pane {
        case .voice: voicePane
        case .english: LetterPane(bridge: bridge, dark: dark)
        case .zhuyin: ZhuyinPane(bridge: bridge, dark: dark)
        }
    }

    /// Resist a drag that would pull the track past either end, so the pane
    /// never detaches from the edge of the keyboard.
    private func rubberBanded(_ dx: CGFloat, width: CGFloat) -> CGFloat {
        let index = bridge.paneIndex
        let overshoot = (index == 0 && dx > 0) || (index == bridge.panes.count - 1 && dx < 0)
        return overshoot ? dx / 4 : max(-width, min(width, dx))
    }

    // MARK: mode strip — wordmark + where you are, or the candidate bar

    /// The wordmark, and the current pane named next to one dot per pane.
    ///
    /// It used to be a segmented control, which read as the *only* way across
    /// and hid the fact that the pane swipes at all. Dots say "there is another
    /// one of these, sideways" — and they stay tappable, so nothing is lost.
    ///
    /// They are a signpost and nothing more now: the bottom row of every pane
    /// carries a real mode key (`ModeKey`), so nothing the user needs depends on
    /// hitting a 5pt mark.
    ///
    /// While a 注音 syllable is being typed the whole row is given over to the
    /// composition and its candidates. It is the one row the keyboard has to
    /// spare, and the alternative — a bar of its own above the keys — would make
    /// the pane taller than its neighbours every time someone started a word.
    private var modeStrip: some View {
        HStack(spacing: 0) {
            if bridge.composition.isEmpty {
                Text(verbatim: "Parley")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(KBTheme.wordmark(dark))
                Spacer(minLength: 8)
                if showsWindowChip {
                    windowChip
                    Spacer(minLength: 8)
                }
                bridge.pane.name
                    .font(.caption.weight(.medium))
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .padding(.trailing, 8)
                    .accessibilityHidden(true)
                HStack(spacing: 5) {
                    ForEach(bridge.panes, id: \.self) { dot($0) }
                }
            } else {
                compositionChip
                candidateBar
            }
        }
        .frame(height: KBMetrics.strip)
        .padding(.horizontal, 12)
    }

    // MARK: 注音 composition

    /// The syllable being typed, in the accent so it reads as pending rather
    /// than as text that has landed somewhere.
    private var compositionChip: some View {
        Text(verbatim: bridge.composition)
            .font(.system(size: 17))
            .foregroundStyle(KBTheme.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(KBTheme.control(dark)))
            .padding(.trailing, 8)
            .accessibilityLabel(Text("Composing"))
            .accessibilityValue(Text(verbatim: bridge.composition))
    }

    /// The characters that reading could be, most frequent first, scrollable
    /// because some readings have dozens. Tapping one commits it; space commits
    /// the first, which is why it is worth having it be the first.
    private var candidateBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(Array(bridge.candidates.enumerated()), id: \.offset) { _, candidate in
                    Button(action: { bridge.pickCandidate(candidate) }) {
                        Text(verbatim: candidate)
                            .font(.system(size: 22))
                            .foregroundStyle(KBTheme.ink(dark))
                            .frame(minWidth: 32, minHeight: KBMetrics.strip - 4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: the microphone window

    /// Whether the next tap on the mic will stay in this app.
    ///
    /// The chip lives in the strip rather than on the voice pane for three
    /// reasons: the strip already has the empty middle it needs, the fact is
    /// true of the keyboard rather than of one pane, and the voice pane is
    /// measured to the point where adding anything to it moves the record
    /// button.
    ///
    /// Hidden during a session. The record button already says the microphone
    /// is live, and a second element saying so is exactly the redundancy this
    /// pane was rebuilt to remove — the chip is about the *next* tap, and
    /// during a session there is no next tap to describe.
    private var showsWindowChip: Bool {
        bridge.hasFullAccess && !bridge.listening && bridge.windowIsOpen
    }

    /// Tapping it ends the window. That is the whole control: there is nothing
    /// else a keyboard could usefully do to one, and a chip that says the
    /// microphone is open without a way to close it is a notice rather than a
    /// control.
    private var windowChip: some View {
        Button(action: { bridge.endWindow() }) {
            HStack(spacing: 5) {
                Circle()
                    .fill(KBTheme.micWindow)
                    .frame(width: 6, height: 6)
                Text("Mic ready")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(KBTheme.ink(dark))
                if let minutes = bridge.windowMinutesLeft {
                    Text(verbatim: "\(minutes)m")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(KBTheme.inkSoft(dark))
                }
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(KBTheme.inkSoft(dark))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(KBTheme.control(dark)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("The microphone is ready. Tap to close it."))
    }

    private func dot(_ pane: KeyboardPane) -> some View {
        let selected = bridge.pane == pane
        return Button(action: { bridge.setPane(pane) }) {
            Capsule()
                .fill(selected ? KBTheme.accent : KBTheme.inkSoft(dark).opacity(0.35))
                .frame(width: selected ? 14 : 5, height: 5)
                // Keep a finger-sized target around a deliberately small mark.
                .contentShape(Rectangle().inset(by: -12))
                .animation(.easeInOut(duration: 0.2), value: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pane.label)
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
    /// delete top-right, return under it, and the mode key bottom-left with the
    /// globe or `@` above it.
    ///
    /// Bottom-left is the mode key's corner on every pane, which is the whole
    /// point of it — a key that moves between panes is only learnable if it is
    /// in the same place on all of them — so the slot that used to be left empty
    /// for the pane to breathe is now what the other two keys share. On the
    /// devices where the system still asks us to draw a globe there are three
    /// keys wanting two slots, and `@` is the one that gives: it is a
    /// convenience here and a real key one swipe away on the letters pane,
    /// whereas the globe is App Review 4.4.1's way out of the keyboard.
    private var deck: some View {
        HStack(spacing: 0) {
            VStack(spacing: KBMetrics.deckRowGap) {
                if bridge.showsGlobe {
                    GlobeKey(controller: bridge.controller, dark: dark, round: true)
                        .frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
                } else {
                    atKey
                }
                ModeKey(
                    bridge: bridge, dark: dark, width: KBMetrics.roundKey,
                    height: KBMetrics.roundKey, round: true)
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
    ///
    /// The **glyph** is where the button stops promising more than it can do. A
    /// microphone means "speak now and the words appear here", and that is only
    /// true when the app is set up and holding an open microphone window;
    /// otherwise the tap goes to Parley, and the button says so. The colour
    /// stays either way — the button is still the thing to press.
    private var recordButton: some View {
        PressableButton(action: toggle, onPressDown: startHaptic) { pressed in
            ZStack {
                if bridge.listening && !reduceMotion {
                    PulseRing(color: KBTheme.recording)
                }
                Circle()
                    .fill(recordFill)
                    .frame(width: KBMetrics.recordSize, height: KBMetrics.recordSize)
                    .brightness(pressed ? -0.06 : 0)
                Image(systemName: recordGlyph)
                    .font(.system(size: bridge.listening ? 24 : 27, weight: .medium))
                    .foregroundStyle(recordInk)
            }
            .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(recordLabel)
    }

    private var recordGlyph: String {
        if bridge.listening { return "stop.fill" }
        return bridge.opensApp ? "arrow.up.forward.app" : "mic.fill"
    }

    /// The label says what the tap does, not what the button is called — the
    /// three idle states are three different actions.
    private var recordLabel: Text {
        if bridge.listening { return Text("Stop dictation") }
        // Without Full Access the button is dimmed and the slot explains why;
        // the label stays what it was so nothing about that state changes.
        guard bridge.hasFullAccess else { return Text("Start dictation") }
        if !bridge.ready { return Text("Open Parley to set up voice typing") }
        if !bridge.windowIsOpen { return Text("Start dictation, which opens Parley first") }
        return Text("Start dictation")
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

    /// One solid thump as the finger lands on the record button, not when it
    /// lifts: the press is the moment the user commits to speaking, and a
    /// confirmation that arrives after the release confirms nothing.
    ///
    /// Only on the press that *starts* something — ⏹ ends with the success
    /// pattern instead (`Haptics.dictationDelivered`), and the two are
    /// deliberately different beats. A keyboard extension only gets haptics at
    /// all with Full Access; without it the button is disabled anyway, and the
    /// guard says so rather than leaving it to be inferred.
    private func startHaptic() {
        guard bridge.hasFullAccess, !bridge.listening else { return }
        Haptics.dictationStarted()
    }

    private func toggle() {
        if bridge.listening {
            bridge.stop()
        } else if !bridge.ready {
            // Nothing to start. Without an account or microphone permission the
            // app can only answer a session request with a failure, and minting
            // one would flip this pane into a listening state that never
            // listens — so the tap does the one thing that helps and opens
            // Parley, where both can be fixed.
            open(DictationChannel.appURL)
        } else {
            // The bridge tries the no-jump start first; the completion only
            // fires when the app really has to come forward.
            bridge.start { url in
                guard let url else { return }
                open(url)
            }
        }
    }

    /// Open the container app. SwiftUI's `openURL` is the path that still works
    /// from a keyboard on iOS 18+; the responder-chain walk covers older
    /// releases.
    private func open(_ url: URL) {
        openURL(url) { accepted in
            if !accepted { bridge.fallbackOpen(url) }
        }
    }

    // MARK: the text slot

    /// One fixed-height slot above the button, so the keyboard never changes
    /// shape between states: the Full Access explainer, an error, the live
    /// transcript, the set-up notice, or the idle prompt.
    ///
    /// The live case shows the settled tail in a softer ink followed by the
    /// words not yet settled. The transcript only reaches the document when the
    /// session is done, so until then this slot is where the words are — which
    /// is also why the fixed height matters more than it looks: beginning to
    /// speak must not resize the keyboard.
    ///
    /// The set-up notice sits *below* the error, not above it: an error names
    /// the actual problem ("turn the microphone on in Settings"), and the
    /// generic invitation to open the app is only better than saying nothing.
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
            } else if !bridge.ready {
                setUpNotice
            } else {
                idleText
            }
        }
        .frame(height: KBMetrics.textHeight)
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.15), value: bridge.listening)
        .animation(.easeInOut(duration: 0.15), value: bridge.reconnecting)
        .animation(.easeOut(duration: 0.12), value: bridge.partial)
    }

    /// The connection dropped mid-sentence. The transcript stays exactly where
    /// it was — nothing already said is thrown away — with one line above it
    /// saying why it stopped growing. Amber rather than the error red: the
    /// session is still alive and the words are being kept.
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

    /// Parley has never been set up far enough to dictate: no account on this
    /// device, or no microphone permission.
    ///
    /// Which of the two it is deliberately isn't said here. The keyboard knows,
    /// but neither can be fixed from a keyboard, the slot is three lines, and
    /// both end in the same place — so the copy names the destination instead of
    /// the diagnosis.
    private var setUpNotice: some View {
        centered {
            VStack(spacing: 3) {
                Text("Set up voice typing in Parley")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(KBTheme.ink(dark))
                Text("Tap to open the app")
                    .font(.caption2)
                    .foregroundStyle(KBTheme.inkSoft(dark).opacity(0.8))
            }
            .multilineTextAlignment(.center)
        }
    }

    /// Idle and set up: what this particular tap is going to do.
    ///
    /// "Tap to speak" is only true while a microphone window is open. It used to
    /// be the headline in both cases, with a caption underneath — *This tap
    /// opens Parley first* — for the people who had turned a window on. That was
    /// backwards: the common case is the one that leaves, and the caption said
    /// exactly what this line now says. So the promise moved into the headline,
    /// where it matches the glyph on the button.
    private var idleText: some View {
        centered {
            Group {
                if bridge.windowIsOpen {
                    Text("Tap to speak")
                } else {
                    Text("Dictation starts in Parley")
                }
            }
            .font(.subheadline)
            .foregroundStyle(KBTheme.inkSoft(dark))
        }
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
