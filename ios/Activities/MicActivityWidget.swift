import ActivityKit
import ParleyKit
import SwiftUI
import WidgetKit

/// The microphone card, on the lock screen and in the Dynamic Island.
///
/// **It is about voice typing.** A meeting recording holds the same microphone
/// and draws nothing — see `MicActivityState.derive` for why, and
/// `docs/design/ios-live-activity.md` for how it got that way. One
/// `ActivityConfiguration` for both remaining modes, because there is one
/// microphone. What this file adds is the drawing, and three rules that shape
/// all of it.
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
/// word on the card is a system semantic colour. Two marks in two colours would
/// be a legend to learn; one dot that is blue or orange is the same mark the
/// user already knows from the keyboard's mic pill and the system's own privacy
/// indicator.
///
/// ## The card is read, not operated
///
/// It used to carry four buttons — finish, discard, stop recording, end standby
/// — and three are gone by decision. Finish-or-discard is not a choice to make
/// on a surface you are glancing at with the phone face-up on a table, and stop
/// recording went with the meeting card. So a **dictation** card is read, not
/// operated: tapping anywhere opens Parley, where each of those decisions is one
/// tap away.
///
/// **Standby keeps its one button**, and that is a different kind of decision
/// rather than a surviving exception — see `EndStandbyButton`. Ending standby
/// settles nothing about content, because standby is the state in which nothing
/// is being recorded; it closes a microphone that is open, on the only surface
/// that offers it from a locked screen.
struct MicActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MicActivityAttributes.self) { context in
            MicActivityCard(face: CardFace(context.state, isStale: context.isStale))
                // Tapping anywhere opens Parley, and since the buttons went it
                // is the card's only interaction. The bare scheme rather than a
                // deep link on purpose: the card is about what is happening
                // now, and the app's own answer to "show me that" is wherever
                // the user left it. A URL that insisted on a destination would
                // be this file guessing at the app's navigation from outside
                // it.
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
                        if let note = face.note {
                            note
                                .font(.footnote)
                                .foregroundStyle(.secondary)
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
                    // Empty while dictating, and it is meant to stay empty.
                    // This region held ⏹ and ✕; deciding what happens to a
                    // transcript is not something to do from a lock screen, so
                    // a dictation card is read rather than operated and the
                    // expanded island simply sits shorter.
                    //
                    // Standby keeps its one button — see `EndStandbyButton`
                    // for why that is a different kind of decision rather than
                    // an exception to this one.
                    //
                    // **Do not put a waveform or any other animated visualiser
                    // here.** It cannot be driven by real audio: a level that
                    // followed the user's voice would need `activity.update()`
                    // to land several times a second from a backgrounded app,
                    // which is this feature's one unverified assumption (see
                    // `MicActivityPolicy.staleAfter`) and would be a battery
                    // cost even if it worked. What is left is a loop that moves
                    // regardless of whether anybody is speaking — a picture of
                    // listening rather than evidence of it, on the one surface
                    // whose entire job is to be believable. That is the cheap
                    // visualiser `docs/design/ios-visual-language.md` rules out.
                    EndStandbyButton(face: face)
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
                // the ranges fixes the arithmetic, not the shape: at the time
                // a meeting's range was honestly unbounded, so any clock here
                // would still have been laid out for `8:00:00`. Meetings are
                // off the card now and both surviving ranges are short, which
                // makes this the one decision here that could be revisited —
                // and it should not be. Taking the clock out is the only
                // version that can never widen again whatever a future mode
                // brings, and the dot already answers the only question a
                // collapsed island is asked.
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
                // pushed off it by a long session.
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
                    if let note = face.note {
                        note
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                Clock(face: face)
                    .font(.title2.monospacedDigit())
                    .foregroundStyle(.primary)
            }
            EndStandbyButton(face: face)
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

/// Standby's one button: close the microphone window now.
///
/// Nothing for the other mode — a dictation card carries no buttons at all, and
/// this is not a hole in that rule. ⏹ and ✕ decided the fate of *words*, which
/// is a judgement about content the card deliberately does not show. Ending
/// standby decides nothing about content, because standby is the state in which
/// **nothing is being recorded**; it turns off a microphone that is open.
///
/// And it is the surface that most needs to offer it. Every place that announces
/// a window has always also been a way to end one — the Settings picker, the
/// Record tab's bar, the keyboard's chip — and this is the fourth and the only
/// one visible from a locked screen, which is exactly where somebody who has
/// just noticed an unexplained orange dot is looking.
///
/// The word comes from `MicActivityCopy`, not from the intent's `title`:
/// AppIntents only accepts a main-bundle `LocalizedStringResource`, and
/// ParleyKit's strings live in `Bundle.module`. Labelling from the title would
/// compile, look right in English, and ship a card with no Chinese on it.
private struct EndStandbyButton: View {
    let face: CardFace

    var body: some View {
        if face.mode == .standby {
            Button(intent: EndMicWindowIntent()) {
                Text(MicActivityCopy.endStandby)
                    .font(.footnote.weight(.medium))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(face.accent)
        }
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
/// an honest short range does not leave a hole — it hands the line beside it
/// the room it was wasting.
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

// MARK: - What the two modes, and the two doubts, come to

/// Everything the card's presentations differ by, worked out once.
///
/// The lock screen and the two island layouts draw the same few things in
/// different arrangements; resolving them here is what keeps a mode from being
/// blue in one presentation and grey in another, which is exactly the kind of
/// disagreement nobody notices until it is on a stranger's lock screen.
private struct CardFace {
    let mode: MicActivityState.Mode
    let accent: Color
    /// The state word: what is happening, or which of the two doubts applies.
    let state: Text
    /// Standby's one line of small print. `nil` for dictation, which has
    /// nothing further to say.
    ///
    /// This used to be two different lines wearing one field — a meeting's name
    /// in headline type and standby's note in quiet footnote type, told apart
    /// by a companion flag. With meetings off the card there is one producer
    /// left, so the flag and the two type scales went with it: the line is
    /// always small print now, and a `nil` is always "there is nothing to add".
    /// Still an `Optional` rather than a `standby`-only branch in the drawing
    /// code, because the two layouts differ in *where* the line goes, not in
    /// whether it exists.
    let note: Text?
    let clock: ClosedRange<Date>
    let countsDown: Bool
    /// The live dot breathes only while the card is making a confident claim.
    let pulses: Bool

    init(_ state: MicActivityState, isStale: Bool) {
        mode = state.mode

        switch state.mode {
        case .dictation:
            note = nil
        case .standby:
            // The whole reason standby has a card. The orange dot in the status
            // bar is the system saying "the microphone is open", which every
            // user has learned to read as "something is listening" — and here
            // it is not. Nothing else on the card can make that distinction, so
            // this line is not decoration and is never dropped.
            note = Text("Microphone open · nothing is being recorded")
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
            // A standby whose `until` did not survive the trip, which has
            // nothing better to fall back on than the card's own lifetime.
            //
            // The eight hours are not invented — they are when the system takes
            // the card away. They are also far wider than any window can be, so
            // this branch draws a clock sized for `8:00:00`; that is the price
            // of not knowing the expiry, and it is only reachable if the app
            // sent a window with an open date and no end, which `derive` does
            // not do. Guessing an hour here to keep the layout tight would be
            // the card inventing a deadline, which is the one thing it may not
            // do.
            clock = state.since...state.since.addingTimeInterval(MicActivityPolicy.systemLimit)
            countsDown = false
        }
    }

    /// Nothing is invented here: both of these already mean this exact thing
    /// somewhere the user has seen it. The **Dark** variants, because a Live
    /// Activity is drawn on a dark system surface in both appearances — and
    /// `Dark.primary` is sky rather than brand blue for the reason written
    /// where it is defined: `#1469D4` is too dark to read on a dark page.
    ///
    /// `ParleyDesignTokens.recording` is no longer read here, and that is the
    /// whole of the colour change: the red still exists and the Record tab
    /// still uses it, but a meeting no longer draws a card for it to appear on.
    private static func accent(for mode: MicActivityState.Mode) -> Color {
        switch mode {
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
