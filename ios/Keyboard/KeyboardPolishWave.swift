import ParleyKit
import SwiftUI

// The voice pane's transcript slot, and the "text wave" it plays while Parley
// polishes a dictation.
//
// The wave exists because `finishing` used to look exactly like `listening`: a
// red stop button, no ripple (nobody is speaking), and words that did not move
// — a pane that read as frozen for as long as the polish took, up to six
// seconds. What it shows instead is the one thing that is actually happening:
// the words being read over. A band of light travels through the last lines in
// reading order, pass after pass, and the three dots on the button rise in
// step with it.
//
// The wave itself — the clock, the text and the dots — is ParleyKit's
// (`PolishWave`, `PolishWaveText`, `PolishWaveDots`), because the app draws the
// same moment elsewhere. What is here is the keyboard's use of it: its inks,
// and the slot it sits in. Both timelines exist only while
// `KeyboardBridge.wave` does — a finish that lasts past a quarter of a second,
// plus the fifth of a second the light takes to leave — so an idle or
// listening pane runs no per-frame work at all.

/// The slot's transcript: the settled tail in the soft ink and the words still
/// being revised in the full one — or, while the words are being polished, the
/// wave.
///
/// `Equatable` on what it draws, so the dozen-a-second publishes a live session
/// makes (the microphone level, mostly) leave it alone: only the text, the
/// appearance, the wave and Reduce Motion can change what is on screen.
struct TranscriptText: View, Equatable {
    var tail: String
    var partial: String
    var dark: Bool
    var wave: PolishWave?
    /// Reduce Motion: no wave, only the text going uniformly to the wave's
    /// resting emphasis while the polish runs.
    var still: Bool

    var body: some View {
        Group {
            if let wave, !still {
                // `.segments`, never `.renderer`: a text renderer draws
                // nothing inside this extension — see `PolishWaveText`.
                PolishWaveText(settled: tail, unsettled: partial, wave: wave, style: style)
            } else if still, let wave, wave.endedAt == nil {
                // Reduce Motion: everything sits at the wave's resting emphasis
                // for as long as the polish runs, and the caption above says
                // why (see `KeyboardRootView.liveText`).
                Text(verbatim: joined).foregroundStyle(style.restingInk)
            } else {
                (Text(verbatim: tail).foregroundStyle(KBTheme.inkSoft(dark))
                    + Text(verbatim: separator)
                    + Text(verbatim: partial).foregroundStyle(KBTheme.ink(dark)))
            }
        }
        .font(.system(size: Self.fontSize))
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static let fontSize: CGFloat = 15

    /// The keyboard's inks: the wave rises from the soft ink the tail already
    /// wears, and its crest leans towards the wordmark's blue — brand in
    /// light, sky in dark.
    private var style: PolishWaveStyle {
        PolishWaveStyle(
            ink: KBTheme.ink(dark), softInk: KBTheme.inkSoft(dark),
            tint: KBTheme.wordmark(dark), fontSize: Self.fontSize)
    }

    /// A space between the two halves when both have words.
    private var separator: String { tail.isEmpty || partial.isEmpty ? "" : " " }
    private var joined: String { tail + separator + partial }
}

/// The slot's scrolling: pinned to the newest line, so the words being spoken
/// are the ones on screen however much has been said, and scrollable upwards
/// to reread the rest.
///
/// It replaces a three-line limit that truncated at the *end* — past three
/// lines the newest words, the only ones the user was looking for, were the
/// ones cut off. The slot keeps its fixed height either way, so starting to
/// speak still cannot resize the keyboard.
///
/// Short text sits at the bottom of the slot, just above the button, as it
/// always has: the content is at least as tall as the slot and aligned to its
/// foot, which also means the bottom anchor has something to anchor from the
/// first word on.
struct TranscriptScroll<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        GeometryReader { geo in
            ScrollView(.vertical, showsIndicators: false) {
                content
                    .frame(
                        maxWidth: .infinity, minHeight: geo.size.height,
                        alignment: .bottomLeading)
            }
            .defaultScrollAnchor(.bottom)
            // A slot that is not full has nothing to scroll to, and a rubber
            // band under the finger would only suggest otherwise.
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}
