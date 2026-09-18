import ActivityKit
// For `LiveActivityIntent` — the constraint on `CardButton`, so that a button
// can only ever be built from an intent that runs in the app's process.
import AppIntents
import ParleyKit
import SwiftUI
import WidgetKit

/// The microphone card, on the lock screen and in the Dynamic Island.
///
/// One `ActivityConfiguration` for all three modes, because there is one
/// microphone — `MicActivityState` explains why that is a fact about the app
/// rather than a layout preference. What this file adds is the drawing, and two
/// rules that shape all of it.
///
/// ## Every clock is a `Text(timerInterval:)`
///
/// Nothing here is a number the app computed and pushed. The system ticks a
/// `Text(timerInterval:)` inside *this* process, from the two dates in the
/// state, so the card stays correct for a backgrounded app whose
/// `activity.update(...)` never arrives — which is an open question on device
/// under the `audio` background mode, and the reason the card was designed to
/// survive the bad answer. See `docs/design/ios-live-activity.md`.
///
/// ## Colour is the dot, and the dot only
///
/// The app's visual language is a plain page with colour used as a signal, not
/// as decoration (`docs/design/ios-visual-language.md`), and a lock screen is
/// the plainest page there is. So the accent lives in one 9pt disc and every
/// word on the card is a system semantic colour. Three marks in three colours
/// would be a legend to learn; one dot that is red, blue or orange is the same
/// mark the user already knows from the Record tab, the keyboard's mic pill and
/// the system's own privacy indicator.
struct MicActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MicActivityAttributes.self) { context in
            MicActivityCard(face: CardFace(context.state, isStale: context.isStale))
                // Tapping anywhere that is not a button opens Parley. The bare
                // scheme rather than a deep link on purpose: the card is about
                // what is happening now, and the app's own answer to "show me
                // that" is wherever it was — a Record tab mid-recording, or the
                // screen the user left. A URL that insisted on a destination
                // would be this file guessing at the app's navigation from
                // outside it.
                .widgetURL(URL(string: "parley://")!)
        } dynamicIsland: { context in
            let face = CardFace(context.state, isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            StatusDot(face: face).accessibilityHidden(true)
                            face.state
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if let detail = face.detail {
                            detail
                                .font(.footnote)
                                .foregroundStyle(face.detailIsHonestyNote ? .secondary : .primary)
                                .lineLimit(2)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Clock(face: face)
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(.primary)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CardButtons(face: face)
                }
            } compactLeading: {
                // The dot, and deliberately nothing beside it. The only
                // question a collapsed island has to answer is the one the card
                // exists for — is the microphone open, and for what — and the
                // dot's colour answers both halves. Elapsed time is something
                // you stop and read, and stopping to read is what the long
                // press and the lock-screen card are for.
                //
                // This region used to be followed by the clock, and that is
                // what made the compact island about four fifths of the screen
                // wide on device while it read `0:25`: a `Text(timerInterval:)`
                // reserves the width of the widest value its range can reach
                // (see `CardFace.init`), and a compact region hands a timer
                // more width than its digits need on top of that. Shortening
                // the ranges fixes the arithmetic, not the shape: a meeting's
                // range is honestly unbounded, so any clock here would still be
                // laid out for `8:00:00`. Taking the clock out is the only
                // version of this that can never widen again, which is the
                // property the other candidates could not offer.
                StatusDot(face: face)
            } compactTrailing: {
                // Nothing, and an empty region is a supported answer rather
                // than a hole: the compact presentation is two slots either
                // side of the camera, and the system decides what an empty one
                // is worth — either it collapses or it keeps a minimum padding
                // around the sensors. Both are the floor. Nothing the widget
                // can put here makes the island narrower than leaving it out,
                // which is the whole point: whatever the floor turns out to
                // measure, this presentation now sits on it and cannot be
                // pushed off it by a long recording.
                //
                // Which side the dot goes on is therefore not a width question,
                // and it is settled by the other presentations: the dot leads
                // the row in the expanded island and on the lock screen, so it
                // leads here too and does not change sides when the island
                // opens.
                //
                // (Reasoned from the layout rules, not measured — there is no
                // device in this loop. What is unverified is how many points an
                // empty region keeps, not whether it can grow.)
                EmptyView()
            } minimal: {
                // What is left when another app's activity is sharing the
                // island: the dot alone. It is the smallest thing that still
                // answers the only question the card exists for — is the
                // microphone open, and for what — which is why the compact
                // presentation above now says exactly as much. Sharing the
                // island stopped being the only situation in which that is
                // enough.
                StatusDot(face: face)
            }
            .keylineTint(face.accent)
            .widgetURL(URL(string: "parley://")!)
        }
    }
}

// MARK: - The lock screen

private struct MicActivityCard: View {
    let face: CardFace

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        StatusDot(face: face).accessibilityHidden(true)
                        face.state
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    if let detail = face.detail {
                        detail
                            .font(face.detailIsHonestyNote ? .footnote : .headline)
                            .foregroundStyle(face.detailIsHonestyNote ? .secondary : .primary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                Clock(face: face)
                    .font(.title2.monospacedDigit())
                    .foregroundStyle(.primary)
            }
            CardButtons(face: face)
        }
        .padding(16)
        // `nil` is the system's own background — a dark blurred material in
        // both appearances — and it is chosen rather than inherited. Parley's
        // `background` token is the app's page, and a lock screen is not a page
        // of Parley's; tinting the card in it would make the one surface the
        // user sees over their wallpaper the only place the brand shouts. It is
        // also why `CardFace` resolves the **Dark** tokens unconditionally: the
        // surface under this card is dark even when iOS is in light mode.
        .activityBackgroundTint(nil)
    }
}

// MARK: - The parts

/// The one coloured thing on the card.
private struct StatusDot: View {
    let face: CardFace

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 9))
            .foregroundStyle(face.accent)
            // A symbol effect rather than a `withAnimation` loop: a widget
            // process does not run an arbitrary `.repeatForever`, and this one
            // the system drives for us. `isActive` is where both honesty rules
            // land — see `CardFace.pulses`.
            .symbolEffect(.pulse, options: .repeating, isActive: face.pulses)
            .accessibilityLabel(face.state)
    }
}

/// Elapsed, or remaining. Never a number this process computed.
///
/// **Its width comes from the range, not from the digits.** A
/// `Text(timerInterval:)` is laid out once, for the widest value its range can
/// reach, and it does not grow as the number does — so the range a mode is
/// given in `CardFace.init` is a layout decision as much as a temporal one, and
/// a clock reading `0:25` can be sized for `8:00:00`. Both places this is drawn
/// pin it to the right and let it take the width it asks for: the lock screen
/// puts a `Spacer` before it, and the expanded island's trailing region sizes
/// itself to its content and gives the rest to the leading one. So a mode with
/// an honest short range does not leave a hole — it hands the meeting title the
/// room it was wasting.
private struct Clock: View {
    let face: CardFace

    var body: some View {
        Text(timerInterval: face.clock, countsDown: face.countsDown)
            // Proportional digits are different widths, so a clock set in them
            // twitches sideways once a second and takes the title next to it
            // with it. Monospaced ones tick in place.
            .monospacedDigit()
    }
}

/// The buttons, on the lock screen and in the expanded island only — the
/// compact and minimal presentations are a few points wide and carry the dot
/// and nothing else.
///
/// **Nothing that destroys recorded audio is on this card, and that is not an
/// oversight to be helpfully corrected.** Dictation's ✕ throws away a
/// transcript that was never inserted anywhere, which costs the user one
/// repetition of a sentence they still remember. A meeting's delete removes an
/// audio file of a conversation that cannot be had again, and it would sit here
/// a thumb's width from Stop, reachable without an unlock, on a screen the user
/// is not looking at carefully. So there is a Stop and there is no Delete, and
/// the asymmetry is the decision.
private struct CardButtons: View {
    let face: CardFace

    var body: some View {
        HStack(spacing: 8) {
            switch face.mode {
            case .meeting:
                CardButton(
                    MicActivityCopy.stopRecording, intent: StopMeetingRecordingIntent(),
                    tint: face.accent)
            case .dictation:
                CardButton(
                    MicActivityCopy.finish, intent: FinishDictationIntent(), tint: face.accent)
                CardButton(
                    MicActivityCopy.discard, intent: CancelDictationIntent(), tint: .secondary)
            case .standby:
                CardButton(
                    MicActivityCopy.endStandby, intent: EndMicWindowIntent(), tint: face.accent)
            }
        }
    }
}

/// The words come from `MicActivityCopy` in ParleyKit rather than from this
/// target's catalog, and deliberately **not** from the intents' own `title`.
///
/// An intent's `title` looks like the right source and cannot be used: AppIntents
/// requires a `LocalizedStringResource` there to resolve against the *main*
/// bundle, so it may not name ParleyKit's module bundle, and
/// `ExtractAppIntentsMetadata` fails the build if it does. The titles are
/// therefore bare English literals that exist for Shortcuts metadata — which
/// nothing surfaces, since all four intents are `isDiscoverable = false`.
/// Labelling the buttons from them would ship an English-only card.
private struct CardButton<I: LiveActivityIntent>: View {
    let label: String
    let intent: I
    let tint: Color

    init(_ label: String, intent: I, tint: Color) {
        self.label = label
        self.intent = intent
        self.tint = tint
    }

    var body: some View {
        // Already localized by `MicActivityCopy`, so the verbatim overload —
        // running it through `LocalizedStringKey` would look the translated
        // string up again in a catalog that has never heard of it.
        Button(label, intent: intent)
            .font(.footnote.weight(.medium))
            .buttonStyle(.bordered)
            .tint(tint)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - What the three modes, and the two doubts, come to

/// Everything the card's presentations differ by, worked out once.
///
/// The lock screen and the two island layouts draw the same four things in
/// different arrangements; resolving them here is what keeps a mode from being
/// red in one presentation and grey in another, which is exactly the kind of
/// disagreement nobody notices until it is on a stranger's lock screen.
private struct CardFace {
    let mode: MicActivityState.Mode
    let accent: Color
    /// The state word: what is happening, or which of the two doubts applies.
    let state: Text
    /// The line under it — a meeting's name, or standby's note. `nil` for
    /// dictation, which has nothing further to say.
    let detail: Text?
    /// Whether `detail` is the standby note rather than a meeting title, which
    /// is the difference between quiet small print and the card's headline.
    let detailIsHonestyNote: Bool
    let clock: ClosedRange<Date>
    let countsDown: Bool
    /// The live dot breathes only while the card is making a confident claim.
    let pulses: Bool

    init(_ state: MicActivityState, isStale: Bool) {
        mode = state.mode

        switch state.mode {
        case .meeting:
            detail = state.title.map(Text.init(verbatim:))
                // The app sends `nil` rather than an English "Recording" when a
                // meeting has no name, because this is the only side that knows
                // the reader's language. Keyed rather than written as its own
                // source string: in English the default title and the state
                // word above it are the same word, and a String Catalog keyed
                // by the source string cannot hold two translations of it —
                // 錄音 and 錄音中 are not interchangeable.
                ?? Text("meeting.untitled.title")
            detailIsHonestyNote = false
        case .dictation:
            detail = nil
            detailIsHonestyNote = false
        case .standby:
            // The whole reason standby has a card. The orange dot in the status
            // bar is the system saying "the microphone is open", which every
            // user has learned to read as "something is listening" — and here
            // it is not. Nothing else on the card can make that distinction, so
            // this line is not decoration and is never dropped.
            detail = Text("Microphone open · nothing is being recorded")
            detailIsHonestyNote = true
        }

        // Two different doubts, and conflating them would cost the card the one
        // thing it is for.
        //
        // `isStale` answers: has anyone vouched for this card inside
        // `MicActivityPolicy.staleAfter`? Nobody has, and the reason may be that
        // the app is dead — so the card hedges rather than asserts, and it wins
        // over `trouble` precisely because a card that cannot be refreshed
        // cannot vouch for its own `trouble` flag either. "This may have
        // stopped" is the weaker claim, and it is the only one still supported.
        //
        // `trouble` answers a different question: the app is alive, it looked,
        // and the microphone is gone or the relay is down. That is a fact
        // somebody asserted, so the card asserts it back.
        if isStale {
            self.state = Text("This may have stopped")
            accent = .secondary
            pulses = false
        } else if state.trouble {
            self.state = Text("Interrupted")
            accent = .secondary
            pulses = false
        } else {
            self.state = Self.label(for: state.mode)
            accent = Self.accent(for: state.mode)
            pulses = true
        }

        // Each mode gets the tightest end it can actually stand behind, and the
        // reason is as much layout as honesty: a `Text(timerInterval:)` reserves
        // the width of the widest value its range can reach the moment it is
        // laid out, and never narrows again (see `Clock`). A range of eight
        // hours draws `0:25` in a box sized for `8:00:00`, which is how the
        // compact island came to take four fifths of the screen.
        if state.mode == .standby, let until = state.until, until > state.since {
            // The only mode with an end somebody else decided — the window's
            // own expiry — so the only one that counts down.
            clock = state.since...until
            countsDown = true
        } else if state.mode == .dictation {
            // A dictation stops itself: `DictationCoordinator` arms a backstop
            // at `dictationLimit` for exactly this reason, so the card can name
            // the session's real ceiling and be laid out as `M:SS`. If the
            // backstop's stop lands a beat late the clock sits at the cap
            // instead of running past it, which is the better of the two
            // failures — the session it is describing is over.
            clock = state.since...state.since.addingTimeInterval(
                MicActivityPolicy.dictationLimit)
            countsDown = false
        } else {
            // A meeting — and a standby whose `until` did not survive the trip,
            // which has nothing better to fall back on.
            //
            // **A meeting is genuinely unbounded and this is not the bug the
            // compact island had.** Nothing in the app stops a recording at a
            // set length, so any tighter end here would be a number the card
            // cannot keep: the clock would freeze while the microphone was
            // still open, which is the one lie this card exists to prevent. The
            // eight hours are not invented either — they are when the system
            // takes the card away, so they are the card's actual lifetime. A
            // wide clock is the cost, and there is room for it in the expanded
            // island and on the lock screen, which are the only two places it
            // is still drawn.
            clock = state.since...state.since.addingTimeInterval(MicActivityPolicy.systemLimit)
            countsDown = false
        }
    }

    /// Nothing is invented here: each of the three already means this exact
    /// thing somewhere the user has seen it. The **Dark** variants, because a
    /// Live Activity is drawn on a dark system surface in both appearances —
    /// and `Dark.primary` is sky rather than brand blue for the reason written
    /// where it is defined: `#1469D4` is too dark to read on a dark page.
    private static func accent(for mode: MicActivityState.Mode) -> Color {
        switch mode {
        // The Record tab's red.
        case .meeting: return Color(hex: ParleyDesignTokens.Dark.recording)
        // The brand signal blue.
        case .dictation: return Color(hex: ParleyDesignTokens.Dark.primary)
        // iOS's own privacy-indicator orange, which the system is showing in
        // the status bar at this very moment and the keyboard's "Mic ready"
        // chip already borrows. One value in both appearances, because the
        // system's dot is one value.
        case .standby: return Color(hex: ParleyDesignTokens.micWindow)
        }
    }

    private static func label(for mode: MicActivityState.Mode) -> Text {
        switch mode {
        case .meeting: return Text("Recording")
        case .dictation: return Text("Voice typing")
        case .standby: return Text("Mic ready")
        }
    }
}

/// `ParleyDesignTokens` stores primitives as hex, and the app turns them into
/// `Color` through `UIColor` in its own `Theme`. This target cannot import the
/// app, and does not want most of what `Theme` does anyway — it resolves no
/// appearance and needs no adaptive pair — so the conversion is four lines
/// here rather than a shared abstraction over two callers who disagree about
/// what they need.
extension Color {
    fileprivate init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1)
    }
}
