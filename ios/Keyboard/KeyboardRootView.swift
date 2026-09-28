import ParleyKit
import SwiftUI

/// The Parley keyboard's face.
///
/// N panes under one strip: the voice pane — a live-transcript slot, one round
/// record button, the three controls a dictating user reaches for and the ✕
/// that only exists while a session does — followed
/// by the typing keyboards the user has enabled, QWERTY and 注音. The panes sit
/// side by side on a track that follows the finger, so a horizontal drag moves
/// one pane either way and the strip's tabs are a second way across rather than
/// the only one.
///
/// The voice pane is drawn as a **control panel, not a keyboard**. Nothing on
/// it types a letter, so it borrows none of UIKit's key-cap treatment: flat
/// translucent discs, no shadows, and one colour — the record button. Filling
/// the pane with caps (which it used to do) made it read as a broken keyboard
/// rather than a place to speak.
///
/// The view paints no background of its own. The system's `UIInputView` shows
/// through, and the controller covers it only when the system is painting the
/// other appearance from the one this view was handed (#441).
///
/// Everything here is presentation only — no audio, no transcript history
/// beyond the short tail shown above the button — so the extension stays well
/// under the jetsam limit keyboard processes run against.
struct KeyboardRootView: View {
    @ObservedObject var bridge: KeyboardBridge
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Dark when the trait collection is, or when the host field asks for a
    /// dark keyboard. See `KeyboardViewController.isDark`.
    var dark: Bool

    /// Live horizontal travel of the pane track while a drag is in flight.
    @GestureState private var drag: CGFloat = 0

    /// Lets the selected tab's capsule slide between tabs instead of blinking
    /// from one to the next.
    @Namespace private var paneTabStrip

    /// The track has taken the touch; the key it began on is cancelled.
    private var swiping: Bool { drag != 0 }

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
                .disabled(swiping)
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
                // A fully transparent point in a keyboard extension never
                // reaches it: the system hit-tests the pixels, so the voice
                // pane's empty space and the gaps between keys passed the
                // touch through and only drawn controls could start a swipe.
                // `contentShape` cannot fix that from inside SwiftUI; a fill
                // below the eye's threshold can.
                .background(KBTheme.hitFill(dark))
                .simultaneousGesture(
                    DragGesture(minimumDistance: 24)
                        .updating($drag) { value, state, _ in
                            state = rubberBanded(value.translation.width, width: width)
                        }
                        .onEnded { value in
                            let dx = value.translation.width
                            guard abs(dx) > KBMetrics.swipeThreshold,
                                abs(dx) > abs(value.translation.height) * 1.5
                            else { return }
                            bridge.stepPane(by: dx < 0 ? 1 : -1)
                        }
                )
                // Hidden rather than covered while the candidate grid is up:
                // the keyboard has no background to cover it with. Hit-testing
                // goes with it, so the track can't be swiped or typed on
                // underneath the grid.
                .opacity(showsCandidateGrid ? 0 : 1)
                .allowsHitTesting(!showsCandidateGrid)
            }
            // The same content area the panes have, so opening the grid cannot
            // change the keyboard's height.
            .overlay {
                if showsCandidateGrid {
                    CandidateGrid(
                        candidates: bridge.zhuyin.candidates, dark: dark,
                        pick: bridge.pickCandidate, backspace: bridge.backspace)
                }
            }
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlayPreferenceValue(PressedKeys.self) { KeyCalloutLayer(dark: dark, keys: $0) }
    }

    /// The typing panes are handed values rather than the bridge to observe,
    /// and `.equatable()` is what lets SwiftUI skip them: this view re-evaluates
    /// on every publish — every keystroke, every microphone reading — and the
    /// forty-odd keys on each pane have nothing to redraw for any of them. See
    /// `ZhuyinPane`.
    @ViewBuilder
    private func paneView(_ pane: KeyboardPane) -> some View {
        switch pane {
        case .voice: voicePane
        case .english:
            LetterPane(
                bridge: bridge, dark: dark, showsGlobe: bridge.showsGlobe,
                returnKey: bridge.returnKeyStyle
            )
            .equatable()
        case .zhuyin:
            ZhuyinPane(
                bridge: bridge, dark: dark, showsGlobe: bridge.showsGlobe,
                returnKey: bridge.returnKeyStyle
            )
            .equatable()
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

    /// The wordmark, and the panes as named tabs on the right.
    ///
    /// The tabs were dots for a while — one per pane, long for the current one —
    /// on the theory that a segmented control would read as the only way across
    /// and hide the swipe. In use the dots simply weren't discoverable: they
    /// were tappable the whole time and nobody took them for a control, so the
    /// panes are named again. The swipe is unchanged and stays the primary way
    /// across — the track still follows the finger — and the tabs are the second
    /// way, for the user who never thinks to drag.
    ///
    /// While a 注音 composition has candidates the whole row is given over to
    /// them. It is the one row the keyboard has to spare, and the alternative —
    /// a bar of its own above the keys — would make the pane taller than its
    /// neighbours every time someone started a word. The composition itself is
    /// marked text in the host field, as on the system keyboard, so the row
    /// holds only the candidates. The one exception is a field whose host
    /// ignores marked text: there the reading has nowhere else to be seen, and
    /// it takes the 1.20 chip at the left of the row again.
    private var modeStrip: some View {
        HStack(spacing: 0) {
            if bridge.zhuyin.isPending {
                // Only a host that ignores marked text gets the chip: anywhere
                // else the reading is already underlined in the field.
                if !bridge.zhuyin.composition.isEmpty { compositionChip }
                if bridge.candidatesExpanded {
                    // The grid below has the candidates; the strip keeps the
                    // way back.
                    Spacer(minLength: 8)
                } else {
                    candidateBar
                }
                if showsExpandKey { expandKey }
            } else if showsSuggestions {
                suggestionBar
            } else {
                Text(verbatim: "Parley")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(KBTheme.wordmark(dark))
                Spacer(minLength: 8)
                if showsWindowChip {
                    windowChip
                    Spacer(minLength: 8)
                }
                paneTabs
            }
        }
        .frame(height: KBMetrics.strip)
        .padding(.horizontal, 12)
        // The same sub-visible fill the pane track has, for the same reason: a
        // fully transparent point in a keyboard extension never receives the
        // touch, so without it only the drawn pixels of ⌄ — two thin strokes —
        // and of each candidate's glyphs were tappable.
        .background(KBTheme.hitFill(dark))
    }

    /// The English pane's word suggestions take the strip on the same terms the
    /// 注音 candidates do, and behind them: candidates belong to the other pane
    /// and can only exist while that one is current, but the two branches are
    /// ordered anyway so the rule is written down rather than inferred.
    private var showsSuggestions: Bool {
        bridge.pane == .english && !bridge.english.suggestions.isEmpty
    }

    /// The pane's short name. 注音 keeps its own name in both localizations: the
    /// keys on that pane *are* 注音, and nothing an English word could say
    /// would identify it faster.
    private func paneName(_ pane: KeyboardPane) -> Text {
        switch pane {
        case .voice: return Text(Image(systemName: "mic"))
        case .english: return Text("English")
        case .zhuyin: return Text(verbatim: "注音")
        }
    }

    private func paneLabel(_ pane: KeyboardPane) -> Text {
        switch pane {
        case .voice: return Text("Voice dictation")
        case .english: return Text("English keyboard")
        case .zhuyin: return Text("Bopomofo keyboard")
        }
    }

    /// The panes as a segmented control.
    ///
    /// Sized to the 38pt strip rather than to UIKit's own segmented control,
    /// which is 32pt tall before its margins and would leave the wordmark
    /// floating: caption text in a 2pt trough is ~22pt, which sits in the strip
    /// with air above and below. The selected segment is drawn in the *key-cap*
    /// colour over the control wash, so it reads as the raised one by the same
    /// rule the keys on the next pane are read by.
    ///
    /// Widths at the narrowest keyboard the app runs on — 320pt, less the
    /// strip's 12pt gutters, so 296pt: wordmark 41 + 8 + chip 92 + 8 + tabs 125
    /// = 274. The tabs' horizontal padding is 7 rather than the 9 the rest of
    /// the strip would suggest, and the mic chip's minutes are gone, because at
    /// 9pt and with them the row wanted 335pt and the chip's label would have
    /// truncated. Every wider phone has 30pt or more to spare.
    private var paneTabs: some View {
        HStack(spacing: 0) {
            ForEach(bridge.panes, id: \.self) { paneTab($0) }
        }
        .padding(2)
        .background(Capsule().fill(KBTheme.control(dark)))
        // On the pane, not on the tab: the selected capsule is one view moving
        // between two positions, so both ends of the move have to be inside the
        // same animation. It is deliberately shorter than the track's spring —
        // the tab has arrived by the time the pane is still settling, which is
        // the right order for a control and its effect.
        .animation(.easeInOut(duration: 0.2), value: bridge.pane)
        // SwiftUI has no tab-bar trait to give the container, so the most it can
        // say is that these belong together.
        .accessibilityElement(children: .contain)
    }

    private func paneTab(_ pane: KeyboardPane) -> some View {
        let selected = bridge.pane == pane
        return Button(action: { bridge.setPane(pane) }) {
            paneName(pane)
                .font(.caption.weight(.medium))
                .foregroundStyle(selected ? KBTheme.ink(dark) : KBTheme.inkSoft(dark))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background {
                    if selected {
                        Capsule()
                            .fill(KBTheme.key(dark))
                            .matchedGeometryEffect(id: "selectedPaneTab", in: paneTabStrip)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(paneLabel(pane))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: 注音 composition

    /// A backstop rather than a layout: `compositionTail` keeps the chip to two
    /// syllables, which at 15pt is under 100pt for almost every reading. The
    /// cap only matters for two four-symbol syllables side by side.
    private static let compositionChipWidth: CGFloat = 120

    /// How many syllables the chip shows. See `compositionTail`.
    private static let compositionChipSyllables = 2

    /// What is being typed but has not landed anywhere yet, in the accent so it
    /// reads as pending rather than as text in the document.
    ///
    /// Only in a field whose host ignores marked text. Everywhere else the
    /// reading is underlined at the caret, `composition` stays empty and the
    /// chip never draws; see `MarkedTextLog`.
    ///
    /// The chip shares the row with the candidate bar, and the bar is the part
    /// the user acts on. It used to show the whole buffer, capped at 170pt: at
    /// six syllables that is the cap, and on a 320pt phone the bar was left with
    /// two or three candidates — "only about three characters", as it was
    /// reported. So it shows the **last two syllables**, behind an ellipsis when
    /// more are pending: the newest syllable is the one the next keystroke
    /// edits, the one before it is enough context to see a segmentation, and the
    /// front of the buffer is already on screen as the candidates themselves.
    /// VoiceOver still gets the whole reading. It is fixed to its natural width,
    /// so the bar can neither squeeze it nor hand it room it has no text for.
    private var compositionChip: some View {
        Text(verbatim: compositionTail)
            // 15pt, two below the 17 it had: the reading is a caption for
            // the candidates beside it, not text the user reads for itself,
            // and at 320pt every point it gives up is a candidate's.
            .font(.system(size: 15))
            .foregroundStyle(KBTheme.accent)
            .lineLimit(1)
            .truncationMode(.head)
            .frame(maxWidth: Self.compositionChipWidth, alignment: .trailing)
            // Hug the text: a flexible frame beside a scroll view is offered
            // the whole cap and takes it, which drew a wide chip around two
            // symbols. Fixed to its ideal width the chip is as wide as the
            // reading, and the cap still truncates an unusually long one.
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(KBTheme.control(dark)))
            .padding(.trailing, 6)
            .accessibilityLabel(Text("Composing"))
            .accessibilityValue(Text(verbatim: bridge.zhuyin.composition))
    }

    /// The last `compositionChipSyllables` of the space-separated reading,
    /// after a `…` when that drops any.
    private var compositionTail: String {
        let syllables = bridge.zhuyin.composition.split(separator: " ")
        guard syllables.count > Self.compositionChipSyllables else {
            return bridge.zhuyin.composition
        }
        return "…" + syllables.suffix(Self.compositionChipSyllables).joined(separator: " ")
    }

    /// What the front of the buffer could be — phrases first, then the first
    /// syllable's characters — most likely first, scrollable because some
    /// readings have dozens. Tapping one commits as many syllables as it has
    /// characters and the bar moves on to what is left.
    ///
    /// Each candidate sits between hairlines with a wide gutter, because the
    /// bar mixes one- and two-character candidates and a run of them with
    /// nothing between reads as one long string: 會出好處會場 is three words,
    /// and at 2pt spacing nobody could tell. The system keyboard leaves about a
    /// character's width between candidates for the same reason.
    private var candidateBar: some View {
        StripBar(
            items: bridge.zhuyin.candidates, dark: dark, fontSize: 22,
            label: Text("Candidates"), action: bridge.pickCandidate
        )
        .equatable()
    }

    /// The grid replaces the 注音 keys only while there is a reading to choose
    /// for. The controller collapses it when the buffer empties; the pane test
    /// is a second guard, so the grid can never sit over another pane's keys.
    private var showsCandidateGrid: Bool {
        bridge.candidatesExpanded && bridge.pane == .zhuyin && bridge.zhuyin.isPending
    }

    /// Only with something to show, or with the grid already open so it can be
    /// closed again.
    private var showsExpandKey: Bool {
        bridge.candidatesExpanded || !bridge.zhuyin.candidates.isEmpty
    }

    /// ⌄ at the end of the candidate bar, as on the system keyboard: the bar
    /// shows what fits in one row, this opens all of them over the keys.
    /// Flips to ⌃ while the grid is open. A hairline sets it off from the last
    /// candidate, so it doesn't read as one.
    private var expandKey: some View {
        let expanded = bridge.candidatesExpanded
        return HStack(spacing: 0) {
            Rectangle()
                .fill(KBTheme.inkSoft(dark).opacity(0.3))
                .frame(width: 1, height: KBMetrics.strip - 18)
            Button(action: { bridge.candidatesExpanded.toggle() }) {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(KBTheme.ink(dark))
                    .frame(width: 32, height: KBMetrics.strip - 4)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? Text("Fewer candidates") : Text("Show more candidates"))
        }
    }

    // MARK: English word suggestions

    /// What the part-typed English word could still become, most frequent
    /// first. Tapping one takes back the letters typed so far and puts the
    /// whole word in, with the space that ends it.
    ///
    /// It takes the strip for exactly as long as the cursor is inside a word,
    /// by the same argument the 注音 candidates take it: the strip is the one
    /// row this keyboard has to spare, and a bar of its own above the keys would
    /// make the English pane taller than its neighbours every time somebody
    /// started a word — which would shove the host app's content up and down
    /// mid-swipe.
    ///
    /// 17pt rather than the candidate bar's 22: Latin words are far wider than
    /// the one- and two-character Chinese candidates, and five of them have to
    /// fit across a 320pt strip.
    private var suggestionBar: some View {
        StripBar(
            items: bridge.english.suggestions, dark: dark, fontSize: 17,
            label: Text("Word suggestions"), action: bridge.pickSuggestion
        )
        .equatable()
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
    ///
    /// It used to carry the minutes left as well. The named tabs took the right
    /// of the strip back from the dots, and on a 320pt keyboard the two cannot
    /// both have what they want — so the countdown went, because the chip is
    /// about *whether* the next tap stays put, which is the part a keyboard can
    /// act on. How long the window has left is Parley's to say, and it does.
    private var windowChip: some View {
        Button(action: { bridge.endWindow() }) {
            HStack(spacing: 4) {
                Circle()
                    .fill(KBTheme.micWindow)
                    .frame(width: 6, height: 6)
                Text("Mic ready")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(KBTheme.ink(dark))
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
    /// delete top-right, return under it, `@` bottom-left, and — while a
    /// session is live — ✕ top-left.
    ///
    /// Top-left is empty the rest of the time. It is where the pane breathes,
    /// and keeping it that way is what lets ✕ arrive without the deck
    /// reflowing: the two ways out of a dictation sit at the same height, one
    /// disc apart, and nothing else on the pane moves when they appear.
    ///
    /// On the devices that draw their own globe the slot holds `@`, and a
    /// session borrows it. That is the one thing this costs, and it is the
    /// right thing to spend: `@` is a shortcut, and it is a shortcut for
    /// something nobody is doing in the middle of speaking. The globe below it
    /// is never touched — a keyboard that can't be switched away from is a
    /// keyboard the user is trapped in.
    private var deck: some View {
        HStack(spacing: 0) {
            VStack(spacing: KBMetrics.deckRowGap) {
                leftTopKey
                if bridge.showsGlobe {
                    // Bottom-left, where the system's own globe sits, so the
                    // muscle memory carries over on the devices that show it.
                    GlobeKey(controller: bridge.controller, dark: dark, round: true)
                        .frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
                } else {
                    resting(atKey)
                }
            }
            .animation(.easeInOut(duration: 0.16), value: bridge.listening)
            Spacer(minLength: 0)
            recordButton
            Spacer(minLength: 0)
            VStack(spacing: KBMetrics.deckRowGap) {
                resting(deleteKey)
                resting(returnKey)
            }
            .animation(.easeInOut(duration: 0.16), value: bridge.listening)
        }
        .frame(height: KBMetrics.deckHeight)
    }

    /// A control that only exists between sessions. While the microphone is
    /// open nothing has landed in the field yet — insertion is one shot at
    /// `done` — so ⌫ would eat text typed *before* the dictation, ⏎ would
    /// break a line under words that have not arrived, and `@` is a shortcut
    /// nobody reaches for mid-sentence. The disc stays where it is, dimmed and
    /// inert, rather than vanishing: a deck that empties out the moment ✕
    /// appears reads as the keyboard breaking, not as keys that are resting.
    private func resting<V: View>(_ control: V) -> some View {
        control
            .opacity(bridge.listening ? 0.35 : 1)
            .disabled(bridge.listening)
    }

    @ViewBuilder
    private var leftTopKey: some View {
        if bridge.listening {
            cancelKey.transition(.opacity)
        } else if bridge.showsGlobe {
            resting(atKey)
        } else {
            Color.clear.frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
        }
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

    /// ✕ — end the session and throw away what was said.
    ///
    /// It exists because ⏹ is not a way out. ⏹ means *deliver*: a sentence
    /// nobody wanted still had to be transcribed into the field and then
    /// deleted by hand, which on this pane means holding ⌫ through a paragraph.
    /// The words are visible above the button while they are being spoken, so
    /// until now the pane let the user watch a mistake happen and do nothing
    /// about it.
    ///
    /// Drawn as an ordinary control disc rather than in the recording red. The
    /// pane keeps its one colour on the record button — which is already red
    /// while a session runs — and a second red thing beside it would compete
    /// with the control the user actually reaches for most. It only exists
    /// while there is a session to throw away, which is most of what it has to
    /// say about itself.
    private var cancelKey: some View {
        PressableButton(action: { bridge.cancel() }, onPressDown: discardHaptic) { pressed in
            disc(pressed: pressed) {
                Image(systemName: "xmark").font(.system(size: 17, weight: .semibold))
            }
        }
        .accessibilityLabel(Text("Discard dictation"))
    }

    /// The counterpart to `startHaptic`, and deliberately a different beat —
    /// see `Haptics.dictationDiscarded`. On the press, like the start: the
    /// press is where the decision is.
    private func discardHaptic() {
        guard bridge.hasFullAccess else { return }
        Haptics.dictationDiscarded()
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
    /// gradient, listening it goes flat recording red and **swells with the
    /// voice**, so "armed" is never something you have to read out of a
    /// gradient — and never needs a second element saying "Listening…" beside
    /// it.
    ///
    /// The **glyph** is where the button stops promising more than it can do. A
    /// microphone means "speak now and the words appear here", and that is only
    /// true when the app is set up and holding an open microphone window;
    /// otherwise the tap goes to Parley, and the button says so. The colour
    /// stays either way — the button is still the thing to press.
    ///
    /// **Finishing** is its own face, because it used to be the listening one:
    /// a red ⏹ over a microphone that had already closed, with no ripple since
    /// nobody was speaking — a button that looked stuck for as long as the
    /// polish took. The moment ⏹ is pressed the red goes and the brand blue
    /// comes back, with nothing on it; if the words are still on their way a
    /// quarter of a second later, three dots rise in step with the wave
    /// reading through the transcript (`PolishWaveDots`). The tap it offers then
    /// is the only one that still means anything: put the words in now,
    /// unpolished.
    private var recordButton: some View {
        PressableButton(action: toggle, onPressDown: pressHaptic) { pressed in
            ZStack {
                // Only while there is a voice. In silence the rings are not
                // faint, they are absent — see `LevelRipple`.
                if hearing, !reduceMotion, bridge.mic.isAudible {
                    LevelRipple(
                        color: KBTheme.recording, level: bridge.mic.level,
                        trail: bridge.mic.trail)
                }
                Circle()
                    .fill(recordFill)
                    .frame(width: KBMetrics.recordSize, height: KBMetrics.recordSize)
                    // The circle and not the ZStack, so the glyph keeps its
                    // size: a ⏹ that grew and shrank with the voice would read
                    // as the *control* changing rather than the level.
                    .scaleEffect(swell)
                    .animation(.linear(duration: MicLevelReading.publishInterval), value: swell)
                    .brightness(pressed ? -0.06 : 0)
                recordFace
            }
            .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(recordLabel)
    }

    /// The microphone is open and listening to the user — a live session that
    /// has not been stopped. The ripple and the swell answer a voice, and only
    /// this state has one.
    private var hearing: Bool { bridge.listening && !bridge.finishing }

    /// What is drawn on the button: the glyph, or while finishing the dots —
    /// and for the first quarter second of a finish, nothing, so a finish that
    /// lands inside it goes straight from the blue to the microphone without a
    /// transition flashing past.
    @ViewBuilder
    private var recordFace: some View {
        Group {
            if bridge.finishing {
                if let wave = bridge.wave {
                    PolishWaveDots(wave: wave, still: reduceMotion)
                        .equatable()
                        .transition(.opacity)
                }
            } else {
                Image(systemName: recordGlyph)
                    .font(.system(size: bridge.listening ? 24 : 27, weight: .medium))
                    .foregroundStyle(recordInk)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: bridge.finishing)
        .animation(.easeOut(duration: 0.18), value: bridge.wave == nil)
    }

    /// How much bigger the button gets at the top of the meter: ⌀80 → ⌀86.4.
    ///
    /// Small on purpose. The button sits in a 100pt deck row with the ripple
    /// behind it, and the ripple is what carries the loudness — the button's
    /// job is to feel alive under the voice, which it does at a few points of
    /// scale, not to be a meter in its own right. It also has to stay clear of
    /// the inner ring (⌀96 at full) or the ring would never be visible around
    /// it, which is the difference between a button with a halo and a button
    /// that got slightly bigger.
    private static let maxSwell: CGFloat = 0.08

    /// The button's size right now, resting at 1.
    ///
    /// Silence is the resting state, and so is every state that is not a live
    /// session: the button has other faces — idle, mic taken, error,
    /// reconnecting — and none of them has a voice to answer.
    ///
    /// Reduce Motion rests too. A level meter is information, but a control
    /// that changes size under the finger is motion by any reading of the
    /// setting, and what that setting buys here is exactly what shipped before
    /// this change: a flat red button.
    private var swell: CGFloat {
        guard hearing, !reduceMotion else { return 1 }
        return 1 + Self.maxSwell * CGFloat(bridge.mic.level)
    }

    /// The glyph follows **readiness, not presence**: a keyboard whose app is
    /// signed in and holds the microphone permission shows a microphone,
    /// whether or not this particular tap will be served in place.
    ///
    /// It used to switch to the jump glyph whenever the tap would open Parley
    /// first. Since #404 a lingering Parley serves the tap where the user is,
    /// so the common case is no longer a jump — and the owner ruled that a
    /// first tap opening the app once is expected behaviour rather than
    /// something the button should warn about. The jump glyph is now reserved
    /// for the one state that really is different: not set up yet.
    private var recordGlyph: String {
        if bridge.listening { return "stop.fill" }
        return bridge.ready ? "mic.fill" : "arrow.up.forward.app"
    }

    /// The label says what the tap does, not what the button is called — the
    /// three idle states are three different actions.
    private var recordLabel: Text {
        if bridge.finishing { return Text("Insert without polishing") }
        if bridge.listening { return Text("Stop dictation") }
        // Without Full Access the button is dimmed and the slot explains why;
        // the label stays what it was so nothing about that state changes.
        guard bridge.hasFullAccess else { return Text("Start dictation") }
        // Two states, matching the glyph: set up, or not set up. Whether this
        // tap is served in place is no longer something the button says — see
        // `recordGlyph`.
        return bridge.ready
            ? Text("Start dictation") : Text("Open Parley to set up voice typing")
    }

    /// Disabled (no Full Access) reads inert rather than inviting: the button
    /// can't record until the user has been through Settings. Red only while
    /// the microphone is actually hearing the user — a finishing session is
    /// back in the brand blue, because nothing it says is being recorded.
    private var recordFill: AnyShapeStyle {
        if !bridge.hasFullAccess { return AnyShapeStyle(KBTheme.control(dark)) }
        if hearing { return AnyShapeStyle(KBTheme.recording) }
        return AnyShapeStyle(KBTheme.micGradient)
    }

    private var recordInk: Color {
        bridge.hasFullAccess ? .white : KBTheme.inkSoft(dark)
    }

    /// A rising two-beat as the finger lands on the record button, not when it
    /// lifts: the press is the moment the user commits to speaking, and a
    /// confirmation that arrives after the release confirms nothing. Only the
    /// pattern's first beat is synchronous with the press; see
    /// `Haptics.dictationStarted` for why it grows rather than thumps once.
    ///
    /// Only on the press that *starts* something — ⏹ ends with the success
    /// pattern instead (`Haptics.dictationDelivered`), and the two are
    /// deliberately different beats. A keyboard extension only gets haptics at
    /// all with Full Access; without it the button is disabled anyway, and the
    /// guard says so rather than leaving it to be inferred.
    ///
    /// The tap that skips the polish plays nothing of its own, for the same
    /// reason ⏹ doesn't: it asks for the words, and the words landing is what
    /// answers it — `Haptics.dictationDelivered`, a moment later. A beat on
    /// the press as well would arrive a round trip ahead of the success pattern
    /// and blur the two into one event; what the press does instead is warm
    /// the engine so that pattern is not late.
    private func pressHaptic() {
        guard bridge.hasFullAccess else { return }
        if bridge.finishing {
            Haptics.prepareForDelivery()
        } else if !bridge.listening {
            Haptics.dictationStarted()
        }
    }

    private func toggle() {
        if bridge.finishing {
            // The words are already on their way; the only thing a tap can
            // still change is whether they wait for the polish.
            bridge.skipPolish()
        } else if bridge.listening {
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
    ///
    /// Once a session is over and its words are still here, the whole slot is
    /// also a button that copies them — see `CopyTarget`.
    private var textSlot: some View {
        Group {
            if !bridge.hasFullAccess {
                fullAccessNotice
            } else if let error = bridge.errorText, !bridge.listening {
                if bridge.tail.isEmpty {
                    centered {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(KBTheme.recording)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    failedText(error)
                }
            } else if bridge.micTaken {
                micTakenNotice
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
        .modifier(
            CopyTarget(
                text: bridge.copyableText, copied: bridge.justCopied, dark: dark,
                copy: bridge.copyDictation))
        .animation(.easeInOut(duration: 0.15), value: bridge.listening)
        .animation(.easeInOut(duration: 0.15), value: bridge.reconnecting)
        .animation(.easeOut(duration: 0.12), value: bridge.partial)
        // The corner swaps in place and nothing else about the slot moves:
        // the words never learn that a tap happened. See `CopyCorner`.
        .animation(.easeOut(duration: 0.15), value: bridge.justCopied)
    }

    /// `content` with the slot's top-trailing corner kept clear for the copy
    /// corner (`CopyCorner`) when `reserve` is set, or `content` alone.
    ///
    /// The column kept clear is as wide as the corner's widest state — the
    /// "✓ Copied" label, not the glyph — measured by laying a hidden copy of
    /// the corner out beside the words rather than by a constant, so it is
    /// right in both languages and at every text size. That is what lets the
    /// label come and go on a full slot without covering a word or moving one.
    ///
    /// Reserved whenever the session is over rather than only while the copy
    /// is on offer: the first key typed afterwards ends the offer, and giving
    /// the width back then would reflow the words under the user's eyes for no
    /// reason they could see. `done` already changes the text — the polished
    /// words replace the raw ones — so taking it there costs no reflow of its
    /// own.
    private func clearOfCopyCorner<Content: View>(
        _ reserve: Bool, @ViewBuilder _ content: () -> Content
    ) -> some View {
        HStack(alignment: .top, spacing: CopyCorner.gap) {
            content()
            if reserve {
                CopyCorner(copied: false, dark: dark)
                    .hidden()
                    .accessibilityHidden(true)
            }
        }
    }

    /// The connection dropped mid-sentence. The transcript stays exactly where
    /// it was — nothing already said is thrown away — with one line above it
    /// saying why it stopped growing. Amber rather than the error red: the
    /// session is still alive and the words are being kept.
    ///
    /// Below the caption the words scroll like the live slot's, pinned to the
    /// newest line: this used to be two lines truncated at the end, which hid
    /// exactly the sentence that was cut off — the one the user most wants to
    /// see kept.
    private var reconnectingText: some View {
        captioned(Text("Reconnecting… keep talking"), in: KBTheme.reconnecting) {
            TranscriptText(tail: bridge.tail, partial: "", dark: dark, wave: nil, still: false)
                .equatable()
        }
    }

    /// A one-line caption above the transcript, for the two states that need
    /// to say why the words have stopped moving: a reconnect, and — under
    /// Reduce Motion, where there is no wave to show it — a polish.
    ///
    /// The caption sits on the words, not at the top of the slot: while they
    /// fit below it the two are one block at the foot of the slot, as before
    /// the slot scrolled, and only a transcript too long for that gets the
    /// caption pinned above a scrolling one.
    private func captioned<Content: View>(
        _ caption: Text, in color: Color, @ViewBuilder transcript: () -> Content
    ) -> some View {
        let label = caption
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
        return VStack(spacing: 0) {
            Spacer(minLength: 0)
            ViewThatFits(in: .vertical) {
                VStack(alignment: .leading, spacing: 2) {
                    label
                    transcript().fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    label
                    TranscriptScroll { transcript() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The system took the microphone — its own dictation, Siri, a call — and
    /// Parley could not get it back.
    ///
    /// One line in the ordinary slot ink, in the same shape as every other
    /// non-live state on this pane: no red, no toast, no alert, and nothing new
    /// on the deck. The pane is already out of its listening shape by the time
    /// this shows, so the record button is back to the tap that starts one —
    /// which is what the second half of the sentence is pointing at.
    ///
    /// It takes the slot rather than sharing it with the echoed transcript, and
    /// that is the trade being made on purpose: nothing is ever inserted from
    /// this state, so the words on screen would be words the user has to retype
    /// either way, and the only thing worth the three lines is the way forward.
    private var micTakenNotice: some View {
        centered {
            Text("Microphone taken by the system. Tap to restart.")
                .font(.footnote)
                .foregroundStyle(KBTheme.inkSoft(dark))
                .multilineTextAlignment(.center)
        }
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

    /// Idle and set up: *Tap to speak*, in every such state.
    ///
    /// This line has been three things. A headline with a caption under it for
    /// the people who had a microphone window on, then — when that read
    /// backwards — a headline that switched to *Dictation starts in Parley*
    /// whenever the tap would leave. Both were answering "will this tap jump",
    /// and since #404 a lingering Parley serves the tap in place, so the jump is
    /// no longer the common case. The owner ruled that a first tap opening
    /// Parley once is expected behaviour rather than something to warn about, so
    /// the line says the one thing that is true of every set-up state and the
    /// glyph above it agrees. `staysPut` and the presence machinery behind it
    /// stay exactly as they are; they are the app's to reason about.
    private var idleText: some View {
        centered {
            Text("Tap to speak")
                .font(.subheadline)
                .foregroundStyle(KBTheme.inkSoft(dark))
        }
    }

    /// The words as they arrive, scrolled to the newest line (`TranscriptScroll`)
    /// — and, once ⏹ has been pressed and the words are being polished, the
    /// wave reading through them (`TranscriptText`).
    ///
    /// Reduce Motion gets no wave. The words settle to the wave's resting
    /// emphasis instead, still, and a caption in the reconnect caption's shape
    /// says what is happening — in the accent rather than amber, because
    /// nothing is wrong.
    ///
    /// Once the session is over the same slot holds the finished words, and a
    /// tap copies them (`CopyTarget`). The words stand clear of the slot's
    /// top-trailing corner from then on, which is where the copy glyph and,
    /// for a moment after a tap, "✓ Copied" appear (`clearOfCopyCorner`).
    @ViewBuilder
    private var liveText: some View {
        let transcript = clearOfCopyCorner(!bridge.listening) {
            TranscriptText(
                tail: bridge.tail, partial: bridge.partial, dark: dark, wave: bridge.wave,
                still: reduceMotion
            )
            .equatable()
        }
        if reduceMotion, bridge.finishing, bridge.wave != nil {
            captioned(Text("Polishing…"), in: KBTheme.accent) { transcript }
        } else {
            TranscriptScroll { transcript }
        }
    }

    /// The session failed with words already said: the error as a caption,
    /// in the error red, above the words it cost.
    ///
    /// This slot used to show the error alone and the words were cleared with
    /// it, so the one ending where nothing reaches the field was also the one
    /// that took the words off the screen. They stay now, laid out the way a
    /// reconnect lays them out — caption on the words, the words scrolling
    /// under it if there are many — and a tap copies all of them. A session
    /// that failed before anything settled has no words to keep and still
    /// gets the centred error on its own.
    ///
    /// The error stays put through a copy: the tap's feedback is the corner's
    /// (`CopyCorner`), and the caption and words alike stand clear of it.
    private func failedText(_ error: String) -> some View {
        clearOfCopyCorner(true) {
            captioned(Text(error), in: KBTheme.recording) {
                TranscriptText(tail: bridge.tail, partial: "", dark: dark, wave: nil, still: false)
                    .equatable()
            }
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

/// The transcript slot as a button that copies the finished dictation, while
/// there is one to copy (`KeyboardBridge.copyableText`); the slot exactly as
/// it was the rest of the time.
///
/// **The whole slot is the target.** The words are the thing the user is
/// looking at, and a small copy button beside them would be one more control
/// on a pane that was rebuilt to have fewer — so the words themselves answer
/// the tap, and the glyph in the corner only says that they will. It is a tap
/// and not a press-and-hold, because a hold on a keyboard reads as "start
/// selecting", which this slot cannot do.
///
/// **Scrolling still works.** The slot is a `ScrollView` (`TranscriptScroll`)
/// and a long dictation has to stay rereadable, so the tap is a plain
/// `onTapGesture`: it fails the moment the finger travels, and the scroll view
/// takes the drag as it always has. `contentShape` gives it the slot's empty
/// top as well as the pixels of the words; the track's sub-visible fill
/// (`KBTheme.hitFill`) is what lets the system deliver a touch there at all.
///
/// **The corner costs no layout.** `CopyCorner` is an overlay in the
/// top-trailing corner, outside the slot's layout and out of hit-testing, so
/// the slot's height — and the keyboard's — cannot change when it appears or
/// when it says "Copied". The words stand clear of that corner on their own
/// (`KeyboardRootView.clearOfCopyCorner`) rather than here, because they have
/// to keep standing clear after the corner has gone.
///
/// **VoiceOver** gets one button, "Copy dictated text", with the text as its
/// value — the words are what the button acts on, so they are what it reads.
private struct CopyTarget: ViewModifier {
    /// What a tap copies; `nil` when the slot is not a copy target.
    var text: String?
    /// A tap just copied: the corner says so, for `KeyboardViewController.copiedLabelHold`.
    var copied: Bool
    var dark: Bool
    var copy: () -> Void

    func body(content: Content) -> some View {
        if let text {
            content
                .overlay(alignment: .topTrailing) {
                    CopyCorner(copied: copied, dark: dark)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
                .onTapGesture(perform: copy)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Copy dictated text"))
                .accessibilityValue(Text(verbatim: text))
                .accessibilityAddTraits(.isButton)
                .accessibilityAction(.default, copy)
        } else {
            content
        }
    }

}

/// The transcript slot's top-trailing corner while the finished dictation can
/// be copied: a faint copy glyph, and for a moment after a tap, "✓ Copied" in
/// its place.
///
/// **The corner, not a caption.** The feedback used to be a caption pinned
/// above the words, in the polishing caption's shape — which on a full slot
/// laid itself over the top visible line and cut it in half, at the one moment
/// the user was looking at those words. The corner is where the tap's promise
/// already was, and the words stand clear of it (`clearOfCopyCorner`), so the
/// answer shows up where the question was asked and covers nothing.
///
/// **Faint glyph, clear answer.** The glyph is a hint that the words can be
/// taken, not a control competing with the record button for the eye, so it
/// is small and in the soft ink. "Copied" is the answer to something the user
/// just did, so it is in the accent and the polishing caption's type — the
/// same voice the pane uses for "this is going fine".
///
/// **Both states always laid out.** One is visible and the other transparent,
/// so the swap is a crossfade in place and the corner's width never changes —
/// which is also what lets a hidden copy of this view measure the column the
/// words keep clear. Reduce Motion gets the crossfade alone; otherwise the
/// label also grows into place from the corner, a scale that moves no layout.
private struct CopyCorner: View {
    var copied: Bool
    var dark: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Between the words and the corner's widest state.
    static let gap: CGFloat = 6

    var body: some View {
        ZStack(alignment: .trailing) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(KBTheme.inkSoft(dark).opacity(0.7))
                .opacity(copied ? 0 : 1)
            HStack(spacing: 2) {
                Image(systemName: "checkmark")
                Text("Copied")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(KBTheme.accent)
            .lineLimit(1)
            .fixedSize()
            .opacity(copied ? 1 : 0)
            .scaleEffect(copied || reduceMotion ? 1 : 0.85, anchor: .trailing)
        }
    }
}

/// Two rings pushed outwards from the record button **by the voice**.
///
/// This replaces a `repeatForever` animation — two rings that breathed out at a
/// fixed 1.2 s whatever was being said, or whether anything was. The note it
/// carried here used to argue that a real meter would cost more than the
/// reassurance was worth, and that argument is what the level mailbox retired:
/// one `Float` twelve times a second is not frame-rate streaming, and a
/// visualiser that mimes listening is the thing this project's rule about
/// amplitude exists to prevent. A canned pulse is reassuring in the precise way
/// that is a lie — it looks identical over a microphone that has stopped
/// hearing anything.
///
/// So both rings are functions of the level, and **in silence there is no
/// ripple at all**: the caller leaves this view out of the tree entirely
/// (`MicMeter.isAudible`), and even inside it every opacity is multiplied by
/// the value driving it, so nothing can fade to "almost gone" and sit there.
///
/// The travel comes from `trail` being `level` a beat later
/// (`KeyboardBridge.MicMeter`): a syllable pushes the inner ring out first and
/// the outer one after it, which is a wavefront moving outward rather than two
/// circles breathing in step. No timer, no `@State`, nothing driving itself.
///
/// **Cheap, because this is a keyboard extension.** Two `Circle`s, and the only
/// things that change are `opacity` and `scaleEffect` — transforms on a layer
/// the GPU already has, never a new shape, a blur, a shadow or a re-layout. No
/// `TimelineView`, no display-link, no per-frame work in this process at all:
/// SwiftUI interpolates between the twelve values a second the app sends and
/// stops the moment they stop changing. At rest the view does not exist.
private struct LevelRipple: View {
    let color: Color
    /// The voice now.
    let level: Float
    /// The voice a beat ago.
    let trail: Float

    /// Full-level reach. The outer ring stops at ⌀104, two points past the
    /// 100pt deck row — the old pulse's maximum was ⌀100 exactly — which is
    /// spent knowingly: at that size the ring is a 16 %-alpha wash sitting over
    /// the gap above the deck, and nothing on this pane moves to make room for
    /// it (the record button's frame is unchanged, so the layout cannot shift).
    private static let innerSpread: CGFloat = 0.20
    private static let outerSpread: CGFloat = 0.30

    var body: some View {
        ZStack {
            ring(trail, spread: Self.outerSpread, alpha: 0.16)
            ring(level, spread: Self.innerSpread, alpha: 0.28)
        }
        .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        .allowsHitTesting(false)
    }

    private func ring(_ value: Float, spread: CGFloat, alpha: Double) -> some View {
        Circle()
            // Both the size and the presence come from the same number, so a
            // ring can only be seen as far out as the voice actually pushed it.
            .fill(color.opacity(alpha * Double(value)))
            .frame(width: KBMetrics.recordSize, height: KBMetrics.recordSize)
            .scaleEffect(1 + spread * CGFloat(value))
            // Bridges the gap between readings so twelve steps a second read as
            // one continuous movement. Matched to the publish interval: longer
            // and the ring lags the voice, shorter and the step shows.
            .animation(.linear(duration: MicLevelReading.publishInterval), value: value)
    }
}

/// The strip's bar of tappable words: the 注音 candidates, and the English
/// pane's word suggestions.
///
/// One view for both because they are the same control — a scrolling row of
/// words, hairlines between them, each one a tap that puts text in the field —
/// and the only differences are the type size and what a tap means. Two copies
/// of it drifted apart the moment one of them was adjusted.
///
/// Each item sits between hairlines with a wide gutter, because a run of words
/// with nothing between them reads as one long string: 會出好處會場 is three
/// candidates, and at 2pt spacing nobody could tell. The system keyboard leaves
/// about a character's width between its own for the same reason, and the
/// English bar needs it just as much — `work` `world` `working` run together
/// otherwise.
///
/// `Equatable` on what it shows, so the publishes that do not touch it — the
/// return key, the microphone chip — leave it alone. Ids stay positional:
/// nothing guarantees a bar's words are distinct, and `\.element` would give
/// two of them one identity.
private struct StripBar: View, Equatable {
    var items: [String]
    var dark: Bool
    /// 22 for Chinese candidates, 17 for Latin words: the same point size makes
    /// a five-word English bar about twice as wide as it can be.
    var fontSize: CGFloat
    /// What this row is, for VoiceOver. The words themselves are their own
    /// labels, so this names the container.
    var label: Text
    var action: (String) -> Void

    /// The action is always the same bridge method for a given bar.
    static func == (a: Self, b: Self) -> Bool {
        a.items == b.items && a.dark == b.dark && a.fontSize == b.fontSize && a.label == b.label
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    if index > 0 { separator }
                    Button(action: { action(item) }) {
                        Text(verbatim: item)
                            .font(.system(size: fontSize))
                            .foregroundStyle(KBTheme.ink(dark))
                            .lineLimit(1)
                            .padding(.horizontal, 11)
                            .frame(minWidth: 44, minHeight: KBMetrics.strip - 4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private var separator: some View {
        Rectangle()
            .fill(KBTheme.inkSoft(dark).opacity(0.3))
            .frame(width: 1, height: KBMetrics.strip - 18)
    }
}
