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

    /// Dark when the trait collection is, or when the host field asks for a
    /// dark keyboard. See `KeyboardViewController.isDark`.
    var dark: Bool

    /// Live horizontal travel of the pane track while a drag is in flight.
    @GestureState private var drag: CGFloat = 0

    /// The track has taken the touch; the key it began on is cancelled.
    private var swiping: Bool { drag != 0 }

    /// The panes whose views exist. See `paneSlot`.
    @State private var builtPanes: Set<KeyboardPane> = []

    var body: some View {
        VStack(spacing: 0) {
            modeStrip
            GeometryReader { geo in
                let width = geo.size.width
                HStack(spacing: 0) {
                    ForEach(bridge.panes, id: \.self) { pane in
                        paneSlot(pane).frame(width: width)
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
                // A held space bar steering the caret (`SpaceKey`) owns its
                // finger: the same sideways drag is not a swipe, here or on
                // release. The bar only becomes a trackpad within 10pt of
                // where it was pressed, well inside the 24pt this needs, so
                // the track can never already be moving when it does.
                .simultaneousGesture(
                    DragGesture(minimumDistance: 24)
                        .updating($drag) { value, state, _ in
                            guard !bridge.spaceCursor.holdsTouch else { return }
                            state = rubberBanded(value.translation.width, width: width)
                        }
                        // The track is about to show a neighbour, so it had
                        // better exist. Built in the same update that first
                        // moves the track, which is fine here: a drag is not
                        // animated, so the neighbour is simply drawn where the
                        // finger has put it. By the time the release animates
                        // a step, it has been there for many frames.
                        .onChanged { _ in
                            if !bridge.spaceCursor.holdsTouch { revealNeighbours() }
                        }
                        .onEnded { value in
                            let dx = value.translation.width
                            guard !bridge.spaceCursor.holdsTouch,
                                abs(dx) > KBMetrics.swipeThreshold,
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
            // A pane set without the tabs or the swipe — the controller
            // sending the keyboard elsewhere because a pane was switched off,
            // in `viewWillAppear`, before anything is on screen — has passed
            // over nothing that was revealed first. The pane it lands on is
            // drawn regardless (`paneSlot`); this records it and anything the
            // move crossed as built, so they stay.
            .onChange(of: bridge.pane) { from, to in reveal(from: from, to: to) }
            .onAppear { builtPanes.insert(bridge.pane) }
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

    /// A pane's view, or an empty space the same size until it is needed.
    ///
    /// The track used to build every pane when the keyboard loaded and keep
    /// them all laid out off screen: the voice pane, forty-odd QWERTY keys and
    /// forty-one 注音 keys, each a stack of views, in a process jetsam kills
    /// somewhere around 48–70 MB. A keyboard opened for dictation never needs
    /// the other two. So a pane is built the first time it is **needed** — it
    /// is the current pane, a drag on the track has begun beside it
    /// (`revealNeighbours`), or a move is about to slide across it (`reveal`) —
    /// and then kept, so swiping back is as instant as it always was. Until
    /// then it is `Color.clear` in the same frame, so the track's width and the
    /// offset arithmetic are exactly what they were.
    ///
    /// `.transition(.identity)` because the swap usually happens inside the
    /// track's animated update: without it the pane would fade in while it
    /// slides.
    @ViewBuilder
    private func paneSlot(_ pane: KeyboardPane) -> some View {
        if pane == bridge.pane || builtPanes.contains(pane) {
            paneView(pane).transition(.identity)
        } else {
            Color.clear.transition(.identity)
        }
    }

    /// Build every pane between two positions on the track, both ends
    /// included: a tab from the voice pane to 注音 slides across English, and
    /// what it slides across has to be there before the slide begins. `true`
    /// when that built anything.
    @discardableResult
    private func reveal(from: KeyboardPane, to: KeyboardPane) -> Bool {
        guard let a = bridge.panes.firstIndex(of: from) ?? bridge.panes.firstIndex(of: to),
            let b = bridge.panes.firstIndex(of: to)
        else { return false }
        let span = Set(bridge.panes[min(a, b)...max(a, b)])
        guard !builtPanes.isSuperset(of: span) else { return false }
        builtPanes.formUnion(span)
        return true
    }

    /// A tab: build what the slide will cross, then slide.
    ///
    /// Not in one update. SwiftUI animates the track by moving each view from
    /// where it was to where it will be, and a view built in the same update as
    /// the move has no "was" — it is simply drawn where it ends up. Measured on
    /// the simulator, a first tap from the voice pane to 注音 did exactly that:
    /// the 注音 keys sat in place from the first frame while the voice pane slid
    /// away underneath them, and English never showed. So when the tap has
    /// something to build, the build is committed first and the move follows on
    /// the next turn of the main queue — one frame later, and only the first
    /// time; after that every pane on the way exists and the tap moves at once.
    private func select(_ pane: KeyboardPane) {
        guard reveal(from: bridge.pane, to: pane) else { return bridge.setPane(pane) }
        DispatchQueue.main.async { bridge.setPane(pane) }
    }

    /// Build the panes either side of the current one. Called on every change
    /// of a drag, so it only touches the state the first time.
    private func revealNeighbours() {
        let index = bridge.paneIndex
        let span = Set(
            bridge.panes[max(0, index - 1)...min(bridge.panes.count - 1, index + 1)])
        if !builtPanes.isSuperset(of: span) { builtPanes.formUnion(span) }
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
                StripHome(
                    bridge: bridge, dark: dark, panes: bridge.panes, pane: bridge.pane,
                    showsWindowChip: showsWindowChip, justCopied: bridge.justCopied,
                    offersCopyHint: bridge.copyHintOffered, select: select
                )
                .equatable()
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
    /// readings have dozens, and cut at `StripBar.drawnLimit` because some have
    /// hundreds (the grid behind ⌄ has them all). Tapping one commits as many
    /// syllables as it has characters and the bar moves on to what is left.
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

    // MARK: the voice pane

    /// Its own view, value-fed and `Equatable`, so the keystrokes on the panes
    /// beside it — which re-evaluate this body — skip it. See `VoicePane`.
    private var voicePane: some View {
        VoicePane(bridge: bridge, dark: dark, voice: bridge.voiceState)
            .equatable()
    }
}

/// The strip at rest: the wordmark, the microphone-window chip when there is
/// one, and the panes as named tabs — everything the strip shows when neither
/// a 注音 reading nor an English word has claimed it. See
/// `KeyboardRootView.modeStrip`.
///
/// Value-fed and `Equatable`, like the panes, because the root re-evaluates on
/// every publish — every keystroke, every microphone reading — and nothing here
/// changes with any of them: only the pane, the pane list, the chip, the copy
/// hint and confirmation, and the appearance do.
private struct StripHome: View, Equatable {
    /// Actions only: `endWindow`, `copyHintShown`.
    let bridge: KeyboardBridge
    var dark: Bool
    var panes: [KeyboardPane]
    var pane: KeyboardPane
    var showsWindowChip: Bool
    /// A tap on the voice pane's transcript just copied it: the wordmark says
    /// "✓ Copied" instead, for `KeyboardViewController.copiedLabelHold`. See
    /// `wordmark`.
    var justCopied: Bool
    /// The first-run hint may take the wordmark's place — see
    /// `KeyboardBridge.copyHintOffered` and `wordmark`.
    var offersCopyHint: Bool
    /// A tab tap. The root view's `select`, not `bridge.setPane`, because the
    /// root is what knows which panes are built: a tab that slides across an
    /// unbuilt one has to build it first (see `KeyboardRootView.paneSlot`).
    /// Always the same method on the same root, so `==` leaves it out.
    var select: (KeyboardPane) -> Void

    /// Lets the selected tab's capsule slide between tabs instead of blinking
    /// from one to the next.
    @Namespace private var paneTabStrip

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Where the chip and the tabs begin, measured from the strip's leading
    /// edge, and the hint's own width — what `hintFits` is decided from.
    /// Measured on the chip and the tabs rather than on the spacer before
    /// them: a `Spacer` with any modifier on it is no longer a spacer to the
    /// stack, and the whole row collapses to the middle.
    @State private var chipLeading: CGFloat = 0
    @State private var tabsLeading: CGFloat = 0
    @State private var hintWidth: CGFloat = 0
    private static let stripSpace = "StripHome"

    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.panes == b.panes && a.pane == b.pane
            && a.showsWindowChip == b.showsWindowChip && a.justCopied == b.justCopied
            && a.offersCopyHint == b.offersCopyHint
    }

    var body: some View {
        HStack(spacing: 0) {
            wordmark
            Spacer(minLength: Self.leadingGap)
            if showsWindowChip {
                windowChip
                    .onGeometryChange(for: CGFloat.self, of: leadingEdge) { chipLeading = $0 }
                Spacer(minLength: 8)
            }
            paneTabs
                .onGeometryChange(for: CGFloat.self, of: leadingEdge) { tabsLeading = $0 }
        }
        .coordinateSpace(.named(Self.stripSpace))
    }

    private func leadingEdge(_ proxy: GeometryProxy) -> CGFloat {
        proxy.frame(in: .named(Self.stripSpace)).minX
    }

    /// "Parley" — or, for a moment after the voice pane's transcript is tapped,
    /// "✓ Copied" in its place.
    ///
    /// **Why the wordmark.** The copy's confirmation used to sit in the
    /// transcript slot's corner, where it needed a copy glyph beside the words
    /// at rest and a column kept clear for it — see `CopyTarget`. The wordmark
    /// is the one thing on the strip that carries no information of its own,
    /// it is already in the brand blue the pane uses for "this went fine", and
    /// it is always there on the voice pane: a copy is only on offer once the
    /// session is over, and nothing claims the strip from this view then — the
    /// 注音 candidates and English suggestions belong to the other panes.
    ///
    /// **Nothing else moves.** Both states are always laid out, invisibly, so
    /// the slot is as wide as the wider of the two in either state and the
    /// chip and the tabs never learn that the label changed. The visible one
    /// rolls: the outgoing text rises a few points as it fades and the incoming
    /// one comes up from below — the same way in both directions, so the label
    /// reads as passing through rather than as bouncing back. Reduce Motion
    /// keeps the crossfade and drops the travel.
    ///
    /// **The first-run hint borrows room; it never takes it.** For a user's
    /// first few dictations (`CopyHint`) the slot says "Tap text to copy"
    /// until the offer ends, in the soft ink — an aside, not the brand. It is
    /// far wider than either state above, and reserving its width at rest
    /// would push the chip over for good, so it is not laid out at all: it is
    /// an overlay from the slot's leading edge, drawn over the empty run up to
    /// the chip or the tabs, and only when it fits in that run with the
    /// stack's usual gap to spare (`hintFits`). Where it does not — the
    /// narrowest phones with the chip up — the wordmark simply stays, and the
    /// strip does not report the hint as shown, so that session does not use
    /// up one of the few. Nothing is ever truncated, overlapped or moved by it.
    private var wordmark: some View {
        let roll: AnyTransition = reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .offset(y: Self.wordmarkRoll).combined(with: .opacity),
                removal: .offset(y: -Self.wordmarkRoll).combined(with: .opacity))
        let lead = self.lead
        return ZStack(alignment: .leading) {
            parleyMark.hidden()
            copiedMark.hidden()
            switch lead {
            case .wordmark: parleyMark.transition(roll)
            case .copied: copiedMark.transition(roll)
            case .hint: EmptyView()
            }
        }
        .foregroundStyle(KBTheme.wordmark(dark))
        .lineLimit(1)
        .fixedSize()
        .overlay(alignment: .leading) {
            ZStack(alignment: .leading) {
                // Measured whether or not it is shown, so the decision to show
                // it never waits on a frame drawn without it.
                hintMark.hidden()
                    .onGeometryChange(for: CGFloat.self, of: \.size.width) { hintWidth = $0 }
                if lead == .hint {
                    hintMark
                        .transition(roll)
                        .onAppear { bridge.copyHintShown() }
                }
            }
            .lineLimit(1)
            .fixedSize()
            .allowsHitTesting(false)
        }
        .animation(.easeOut(duration: 0.18), value: lead)
    }

    /// What the wordmark slot shows.
    private enum Lead { case wordmark, hint, copied }

    private var lead: Lead {
        if justCopied { return .copied }
        // The voice pane only: the hint points at the words, which the other
        // panes do not show.
        if offersCopyHint, pane == .voice, hintFits { return .hint }
        return .wordmark
    }

    /// The hint fits between the strip's leading edge — where the slot
    /// starts — and whatever comes next, keeping the gap the stack keeps
    /// anyway. False until both widths have been measured.
    private var hintFits: Bool {
        let next = showsWindowChip ? chipLeading : tabsLeading
        return hintWidth > 0 && next > 0 && hintWidth <= next - Self.leadingGap
    }

    /// The least room between the wordmark slot and whatever follows it.
    private static let leadingGap: CGFloat = 8

    /// How far the wordmark and "✓ Copied" travel as they swap.
    private static let wordmarkRoll: CGFloat = 4

    /// Hidden from VoiceOver: the slot it describes is already a button that
    /// reads "Copy dictated text".
    private var hintMark: some View {
        Text("Tap text to copy")
            .font(.footnote)
            .foregroundStyle(KBTheme.inkSoft(dark))
            .accessibilityHidden(true)
    }

    private var parleyMark: some View {
        Text(verbatim: "Parley")
            .font(.footnote.weight(.bold))
    }

    /// Hidden from VoiceOver: a copy is announced when it happens (see
    /// `KeyboardViewController.copyDictation`), and a label that disappears on
    /// its own is a poor thing to leave a VoiceOver cursor on.
    ///
    /// The tick a size down from the word, and tight to it: the label is the
    /// wider of the two states, so its width is the strip's at 320pt (see
    /// `paneTabs`).
    private var copiedMark: some View {
        HStack(spacing: 2) {
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
            Text("Copied")
                .font(.footnote.weight(.semibold))
        }
        .accessibilityHidden(true)
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
    /// strip's 12pt gutters, so 296pt: wordmark 60 + 8 + chip 92 + 8 + tabs 125
    /// = 293. The wordmark's 60 is "✓ Copied", the wider of its two states,
    /// which it keeps laid out even while it reads "Parley" (41) — see
    /// `wordmark`. The first-run copy hint is not counted: it takes no width of
    /// its own and is skipped when the run beside the wordmark cannot hold it. The tabs' horizontal padding is 7 rather than the 9 the rest
    /// of the strip would suggest, and the mic chip's minutes are gone, because
    /// at 9pt and with them the row wanted 335pt and the chip's label would
    /// have truncated. Every wider phone has 30pt or more to spare.
    private var paneTabs: some View {
        HStack(spacing: 0) {
            ForEach(panes, id: \.self) { paneTab($0) }
        }
        .padding(2)
        .background(Capsule().fill(KBTheme.control(dark)))
        // On the pane, not on the tab: the selected capsule is one view moving
        // between two positions, so both ends of the move have to be inside the
        // same animation. It is deliberately shorter than the track's spring —
        // the tab has arrived by the time the pane is still settling, which is
        // the right order for a control and its effect.
        .animation(.easeInOut(duration: 0.2), value: pane)
        // SwiftUI has no tab-bar trait to give the container, so the most it can
        // say is that these belong together.
        .accessibilityElement(children: .contain)
    }

    private func paneTab(_ pane: KeyboardPane) -> some View {
        let selected = self.pane == pane
        return Button(action: { select(pane) }) {
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
struct LevelRipple: View {
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
/// It draws at most `drawnLimit` of what it is handed; see there for why.
///
/// `Equatable` on what it draws, so the publishes that do not touch it — the
/// return key, the microphone chip, a keystroke that only changed candidates
/// past the ones drawn — leave it alone. Ids stay positional: nothing
/// guarantees a bar's words are distinct, and `\.element` would give two of
/// them one identity.
private struct StripBar: View, Equatable {
    /// The most items the bar draws. The 注音 composer hands it every
    /// candidate, and that can be hundreds: forty phrases, then the first
    /// syllable's whole toneless row — `~ㄧ` is 441 characters, `~ㄐㄧ` 378,
    /// and sixty-odd rows run past a hundred — then its fuzzy variants. This
    /// is not a lazy stack, so every one of them was a `Button`, a `Text` and a
    /// hairline rebuilt on every keystroke and every tick of a held ⌫, which is
    /// where the 注音 pane's time went (AttributeGraph churn and CJK glyph
    /// rasterisation, measured) and a good part of why its footprint climbed.
    ///
    /// Thirty is about five strip-widths of scrolling at 320pt, where a
    /// width shows about six single characters, and further than anyone scrolls
    /// a bar rather than opening the grid: the ⌄ at the strip's end is shown
    /// whenever there is any candidate at all, and `CandidateGrid` — a
    /// `LazyVGrid` that only builds the cells on screen — is where the rest
    /// live. The composer's list is not cut, only what is drawn of it, so a
    /// tap here and a tap in the grid pick from the same list and insert the
    /// same text. The English bar is handed five and never reaches the cap.
    static let drawnLimit = 30

    var items: [String]
    var dark: Bool
    /// 22 for Chinese candidates, 17 for Latin words: the same point size makes
    /// a five-word English bar about twice as wide as it can be.
    var fontSize: CGFloat
    /// What this row is, for VoiceOver. The words themselves are their own
    /// labels, so this names the container.
    var label: Text
    var action: (String) -> Void

    /// The items the bar draws, which is all it compares.
    private var drawn: ArraySlice<String> { items.prefix(Self.drawnLimit) }

    /// The action is always the same bridge method for a given bar.
    static func == (a: Self, b: Self) -> Bool {
        a.drawn == b.drawn && a.dark == b.dark && a.fontSize == b.fontSize && a.label == b.label
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(drawn.enumerated()), id: \.offset) { index, item in
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
