import ParleyKit
import SwiftUI

/// The voice pane: a live-transcript slot, one round record button, the three
/// controls a dictating user reaches for and the ✕ that only exists while a
/// session does. See `KeyboardRootView` for how it sits on the track, and why
/// it is drawn as a control panel rather than a keyboard.
///
/// **It does not observe the bridge**, for the reason `ZhuyinPane` doesn't.
/// It used to be built inline in `KeyboardRootView.body`, and that body runs on
/// every publish the bridge makes — every English and 注音 keystroke among
/// them — so each key re-evaluated this pane's forty-odd views, off screen,
/// to draw nothing new. So the bridge is held for its actions only, everything
/// the pane draws arrives as one `KeyboardBridge.VoiceState` value, and the
/// pane is `Equatable` on it: `KeyboardRootView` wraps it in `.equatable()`
/// and SwiftUI skips this body whenever the value is unchanged, which on a
/// keystroke is always.
///
/// It still redraws for everything it does show, the microphone level twelve
/// times a second during a session included: that is the pane's own state, and
/// what the ripple and the swell are drawn from.
struct VoicePane: View, Equatable {
    /// Actions only. Holding it as `@ObservedObject` is what this type exists
    /// not to do; see above.
    let bridge: KeyboardBridge
    var dark: Bool
    /// What the pane draws, as one value — see `KeyboardBridge.voiceState`.
    var voice: KeyboardBridge.VoiceState

    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What the pane draws. The bridge is the same object for the process's
    /// life and every action is a method on it, so neither needs comparing.
    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.voice == b.voice
    }

    var body: some View {
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
                if voice.showsGlobe {
                    // Bottom-left, where the system's own globe sits, so the
                    // muscle memory carries over on the devices that show it.
                    GlobeKey(controller: bridge.controller, dark: dark, round: true)
                        .frame(width: KBMetrics.roundKey, height: KBMetrics.roundKey)
                } else {
                    resting(atKey)
                }
            }
            .animation(.easeInOut(duration: 0.16), value: voice.listening)
            Spacer(minLength: 0)
            recordButton
            Spacer(minLength: 0)
            VStack(spacing: KBMetrics.deckRowGap) {
                resting(deleteKey)
                resting(returnKey)
            }
            .animation(.easeInOut(duration: 0.16), value: voice.listening)
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
            .opacity(voice.listening ? 0.35 : 1)
            .disabled(voice.listening)
    }

    @ViewBuilder
    private var leftTopKey: some View {
        if voice.listening {
            cancelKey.transition(.opacity)
        } else if voice.showsGlobe {
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
        guard voice.hasFullAccess else { return }
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
                Image(systemName: voice.returnKey.glyph).font(.system(size: 17))
            }
        }
        .accessibilityLabel(Text(voice.returnKey.label))
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
                if hearing, !reduceMotion, voice.mic.isAudible {
                    LevelRipple(
                        color: KBTheme.recording, level: voice.mic.level,
                        trail: voice.mic.trail)
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
        .disabled(!voice.hasFullAccess)
        .accessibilityLabel(recordLabel)
    }

    /// The microphone is open and listening to the user — a live session that
    /// has not been stopped. The ripple and the swell answer a voice, and only
    /// this state has one.
    private var hearing: Bool { voice.listening && !voice.finishing }

    /// What is drawn on the button: the glyph, or while finishing the dots —
    /// and for the first quarter second of a finish, nothing, so a finish that
    /// lands inside it goes straight from the blue to the microphone without a
    /// transition flashing past.
    @ViewBuilder
    private var recordFace: some View {
        Group {
            if voice.finishing {
                if let wave = voice.wave {
                    PolishWaveDots(wave: wave, still: reduceMotion)
                        .equatable()
                        .transition(.opacity)
                }
            } else {
                Image(systemName: recordGlyph)
                    .font(.system(size: voice.listening ? 24 : 27, weight: .medium))
                    .foregroundStyle(recordInk)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: voice.finishing)
        .animation(.easeOut(duration: 0.18), value: voice.wave == nil)
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
        return 1 + Self.maxSwell * CGFloat(voice.mic.level)
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
        if voice.listening { return "stop.fill" }
        return voice.ready ? "mic.fill" : "arrow.up.forward.app"
    }

    /// The label says what the tap does, not what the button is called — the
    /// three idle states are three different actions.
    private var recordLabel: Text {
        if voice.finishing { return Text("Insert without polishing") }
        if voice.listening { return Text("Stop dictation") }
        // Without Full Access the button is dimmed and the slot explains why;
        // the label stays what it was so nothing about that state changes.
        guard voice.hasFullAccess else { return Text("Start dictation") }
        // Two states, matching the glyph: set up, or not set up. Whether this
        // tap is served in place is no longer something the button says — see
        // `recordGlyph`.
        return voice.ready
            ? Text("Start dictation") : Text("Open Parley to set up voice typing")
    }

    /// Disabled (no Full Access) reads inert rather than inviting: the button
    /// can't record until the user has been through Settings. Red only while
    /// the microphone is actually hearing the user — a finishing session is
    /// back in the brand blue, because nothing it says is being recorded.
    private var recordFill: AnyShapeStyle {
        if !voice.hasFullAccess { return AnyShapeStyle(KBTheme.control(dark)) }
        if hearing { return AnyShapeStyle(KBTheme.recording) }
        return AnyShapeStyle(KBTheme.micGradient)
    }

    private var recordInk: Color {
        voice.hasFullAccess ? .white : KBTheme.inkSoft(dark)
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
        guard voice.hasFullAccess else { return }
        if voice.finishing {
            Haptics.prepareForDelivery()
        } else if !voice.listening {
            Haptics.dictationStarted()
        }
    }

    private func toggle() {
        if voice.finishing {
            // The words are already on their way; the only thing a tap can
            // still change is whether they wait for the polish.
            bridge.skipPolish()
        } else if voice.listening {
            bridge.stop()
        } else if !voice.ready {
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
            if !voice.hasFullAccess {
                fullAccessNotice
            } else if let error = voice.errorText, !voice.listening {
                if voice.tail.isEmpty {
                    centered {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(KBTheme.recording)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    failedText(error)
                }
            } else if let notice = voice.noticeText, !voice.listening {
                noticedText(notice)
            } else if voice.micTaken {
                micTakenNotice
            } else if voice.reconnecting {
                reconnectingText
            } else if voice.listening || !voice.tail.isEmpty {
                liveText
            } else if !voice.ready {
                setUpNotice
            } else {
                idleText
            }
        }
        .frame(height: KBMetrics.textHeight)
        .frame(maxWidth: .infinity)
        .modifier(
            CopyTarget(
                text: voice.copyableText, copied: voice.justCopied, dark: dark,
                copy: bridge.copyDictation))
        .animation(.easeInOut(duration: 0.15), value: voice.listening)
        .animation(.easeInOut(duration: 0.15), value: voice.reconnecting)
        .animation(.easeOut(duration: 0.12), value: voice.partial)
        // The corner swaps in place and nothing else about the slot moves:
        // the words never learn that a tap happened. See `CopyCorner`.
        .animation(.easeOut(duration: 0.15), value: voice.justCopied)
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
            TranscriptText(tail: voice.tail, partial: "", dark: dark, wave: nil, still: false)
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
        let transcript = clearOfCopyCorner(!voice.listening) {
            TranscriptText(
                tail: voice.tail, partial: voice.partial, dark: dark, wave: voice.wave,
                still: reduceMotion
            )
            .equatable()
        }
        if reduceMotion, voice.finishing, voice.wave != nil {
            captioned(Text("Polishing…"), in: KBTheme.accent) { transcript }
        } else if let seconds = voice.countdown, voice.listening, !voice.finishing {
            // The last half-minute before the app's cap stops the session. A
            // caption in the reconnect caption's shape and the slot's soft ink:
            // there to be seen by someone who glances at the pane, not an
            // alarm — nothing is wrong, and when it runs out the words are
            // delivered as if ⏹ had been pressed.
            captioned(Text("Stops in \(seconds) s"), in: KBTheme.inkSoft(dark)) { transcript }
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
                TranscriptText(tail: voice.tail, partial: "", dark: dark, wave: nil, still: false)
                    .equatable()
            }
        }
    }

    /// The session was delivered but ended on its own — the cap, or a
    /// connection that did not come back — and the words above are what was
    /// inserted. Laid out as `failedText` lays out an error, caption on the
    /// words, but in the reconnect amber rather than the error red: it is
    /// something to know, not something that went wrong with the text. A cap
    /// reached in silence has no words to caption, and gets the note centred
    /// on its own, the way an error with no words does.
    @ViewBuilder
    private func noticedText(_ notice: String) -> some View {
        if voice.tail.isEmpty {
            centered {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(KBTheme.reconnecting)
                    .multilineTextAlignment(.center)
            }
        } else {
            clearOfCopyCorner(true) {
                captioned(Text(notice), in: KBTheme.reconnecting) {
                    TranscriptText(
                        tail: voice.tail, partial: "", dark: dark, wave: nil, still: false
                    )
                    .equatable()
                }
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
/// (`VoicePane.clearOfCopyCorner`) rather than here, because they have
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

extension KeyboardBridge {
    /// Everything the voice pane draws, as one `Equatable` value — see
    /// `VoicePane` for why the pane is handed this rather than the bridge.
    ///
    /// A copy of the published fields it reads and nothing else, so a publish
    /// the pane does not draw from — the English word, the 注音 strip, the pane
    /// index — leaves it equal and the pane unevaluated. A field the pane starts
    /// reading has to be added here, or the pane will not redraw when it
    /// changes.
    struct VoiceState: Equatable {
        var hasFullAccess: Bool
        var listening: Bool
        var finishing: Bool
        var wave: PolishWave?
        var reconnecting: Bool
        var partial: String
        var tail: String
        var showsGlobe: Bool
        var errorText: String?
        /// See `KeyboardBridge.noticeText`.
        var noticeText: String?
        /// See `KeyboardBridge.countdown`.
        var countdown: Int?
        var micTaken: Bool
        var copyableText: String?
        var justCopied: Bool
        var mic: MicMeter
        var ready: Bool
        /// The ⏎ disc's glyph and VoiceOver label.
        var returnKey: ReturnKeyStyle
    }

    var voiceState: VoiceState {
        VoiceState(
            hasFullAccess: hasFullAccess, listening: listening, finishing: finishing, wave: wave,
            reconnecting: reconnecting, partial: partial, tail: tail, showsGlobe: showsGlobe,
            errorText: errorText, noticeText: noticeText, countdown: countdown,
            micTaken: micTaken, copyableText: copyableText,
            justCopied: justCopied, mic: mic, ready: ready, returnKey: returnKeyStyle)
    }
}
