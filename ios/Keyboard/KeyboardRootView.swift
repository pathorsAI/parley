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

    /// The host field's appearance when it names one — a dark-themed app puts
    /// a dark keyboard on screen even in light mode — and the trait collection's
    /// when it leaves it at `.default`. See `KeyboardViewController.isDark`.
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
                .background(Color.white.opacity(0.01))
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
                        candidates: bridge.candidates, dark: dark,
                        pick: bridge.pickCandidate, backspace: bridge.backspace)
                }
            }
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
    /// While a 注音 composition is pending the whole row is given over to it and
    /// its candidates. It is the one row the keyboard has to spare, and the
    /// alternative — a bar of its own above the keys — would make the pane
    /// taller than its neighbours every time someone started a word. The
    /// composition can be several syllables; the two of them share the row, so
    /// the chip is capped and the bar keeps the rest.
    private var modeStrip: some View {
        HStack(spacing: 0) {
            if !bridge.zhuyin.composition.isEmpty {
                compositionChip
                if bridge.candidatesExpanded {
                    // The grid below has the candidates; the strip keeps the
                    // reading and the way back.
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
        .background(Color.white.opacity(0.01))
    }

    /// The English pane's word suggestions take the strip on the same terms the
    /// 注音 composition does, and behind it: a pending composition belongs to the
    /// other pane and can only exist while that one is current, but the two
    /// branches are ordered anyway so the rule is written down rather than
    /// inferred.
    private var showsSuggestions: Bool {
        bridge.pane == .english && !bridge.english.suggestions.isEmpty
    }

    /// The pane's short name. 注音 keeps its own name in both localizations: the
    /// keys on that pane *are* 注音, and nothing an English word could say
    /// would identify it faster.
    @ViewBuilder
    private func paneName(_ pane: KeyboardPane) -> some View {
        switch pane {
        case .voice: Text("Voice")
        case .english: Text("English")
        case .zhuyin: Text(verbatim: "注音")
        }
    }

    private func paneLabel(_ pane: KeyboardPane) -> Text {
        switch pane {
        case .voice: return Text("Voice dictation")
        case .english: return Text("English keyboard")
        case .zhuyin: return Text("Bopomofo keyboard")
        }
    }

    /// The panes, named, as a segmented control.
    ///
    /// Sized to the 38pt strip rather than to UIKit's own segmented control,
    /// which is 32pt tall before its margins and would leave the wordmark
    /// floating: caption text in a 2pt trough is ~22pt, which sits in the strip
    /// with air above and below. The selected segment is drawn in the *key-cap*
    /// colour over the control wash, so it reads as the raised one by the same
    /// rule the keys on the next pane are read by.
    ///
    /// Widths at the narrowest keyboard the app runs on — 320pt, less the
    /// strip's 12pt gutters, so 296pt: wordmark 41 + 8 + chip 92 + 8 + tabs 144
    /// = 293. The tabs' horizontal padding is 7 rather than the 9 the rest of
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

    /// About 45% of the strip on every phone the keyboard runs on — 320pt to
    /// 440pt wide — which is the most the chip can take before the candidate bar
    /// stops being able to show a candidate the user would have picked anyway.
    private static let compositionChipWidth: CGFloat = 170

    /// What is being typed but has not landed anywhere yet — up to six syllables,
    /// space-separated — in the accent so it reads as pending rather than as
    /// text in the document.
    ///
    /// It is capped at roughly the left half of the strip and truncated from the
    /// *head*, because the row is shared with the candidate bar: a long
    /// composition must not push the candidates off the end, and the syllable
    /// the next keystroke edits is the newest one, on the right. It is fixed to
    /// its natural width up to that cap, so the bar can neither squeeze it nor
    /// hand it room it has no text for.
    private var compositionChip: some View {
        Text(verbatim: bridge.zhuyin.composition)
            .font(.system(size: 17))
            .foregroundStyle(KBTheme.accent)
            .lineLimit(1)
            .truncationMode(.head)
            .frame(maxWidth: Self.compositionChipWidth, alignment: .trailing)
            // Hug the text: a flexible frame beside a scroll view is offered
            // the whole cap and takes it, which drew a 170pt chip around two
            // symbols. Fixed to its ideal width the chip is as wide as the
            // reading, and the cap still truncates a six-syllable one.
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(KBTheme.control(dark)))
            .padding(.trailing, 8)
            .accessibilityLabel(Text("Composing"))
            .accessibilityValue(Text(verbatim: bridge.zhuyin.composition))
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
        bridge.candidatesExpanded && bridge.pane == .zhuyin && !bridge.composition.isEmpty
    }

    /// Only with something to show, or with the grid already open so it can be
    /// closed again.
    private var showsExpandKey: Bool {
        bridge.candidatesExpanded || !bridge.candidates.isEmpty
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
                    .frame(width: 36, height: KBMetrics.strip - 4)
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
    /// by the same argument the 注音 composition takes it: the strip is the one
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
    private var recordButton: some View {
        PressableButton(action: toggle, onPressDown: startHaptic) { pressed in
            ZStack {
                // Only while there is a voice. In silence the rings are not
                // faint, they are absent — see `LevelRipple`.
                if bridge.listening, !reduceMotion, bridge.mic.isAudible {
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
                Image(systemName: recordGlyph)
                    .font(.system(size: bridge.listening ? 24 : 27, weight: .medium))
                    .foregroundStyle(recordInk)
            }
            .frame(width: KBMetrics.deckHeight, height: KBMetrics.deckHeight)
        }
        .disabled(!bridge.hasFullAccess)
        .accessibilityLabel(recordLabel)
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
        guard bridge.listening, !reduceMotion else { return 1 }
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
    /// can't record until the user has been through Settings.
    private var recordFill: AnyShapeStyle {
        if !bridge.hasFullAccess { return AnyShapeStyle(KBTheme.control(dark)) }
        if bridge.listening { return AnyShapeStyle(KBTheme.recording) }
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
