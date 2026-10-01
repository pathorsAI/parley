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
/// appearance, the wave, Reduce Motion and the copy wash can change what is on
/// screen.
struct TranscriptText: View, Equatable {
    var tail: String
    var partial: String
    var dark: Bool
    var wave: PolishWave?
    /// Reduce Motion: no wave, only the text going uniformly to the wave's
    /// resting emphasis while the polish runs.
    var still: Bool
    /// A tap just copied these words (`KeyboardBridge.justCopied`): they wear
    /// a wash in the wordmark's blue, the way selected text does, for as long
    /// as the strip says "Copied".
    ///
    /// Behind the words and sized to them — not to the slot — so a short
    /// dictation at the foot of the slot is washed where it is, rather than
    /// under a block of empty slot above it; and a background, so it moves no
    /// layout. It comes up in about a tenth of a second, to land with the tap,
    /// and goes down slowly, so it reads as the tap's echo fading rather than
    /// as something switching off. Only ever set once the session is over, so
    /// it never meets the polishing wave.
    var washed = false

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
                // Nothing between the two halves: see `PolishWave.transcript`.
                (Text(verbatim: tail).foregroundStyle(KBTheme.inkSoft(dark))
                    + Text(verbatim: partial).foregroundStyle(KBTheme.ink(dark)))
            }
        }
        .font(.system(size: Self.fontSize))
        .multilineTextAlignment(.leading)
        // Before the frame, so the wash hugs the text: one line is as wide as
        // its words, several are as wide as the longest.
        .background {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(KBTheme.wordmark(dark).opacity(0.16))
                .padding(-Self.washOutset)
                .opacity(washed ? 1 : 0)
                .animation(
                    washed ? .easeOut(duration: 0.12) : .easeOut(duration: 0.5),
                    value: washed)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static let fontSize: CGFloat = 15

    /// How far the copy wash reaches past the words on every side, so the
    /// first and last glyphs are not flush with its edge. `TranscriptScroll`
    /// clips this much outside its bounds for the same reason.
    static let washOutset: CGFloat = 3

    /// The keyboard's inks: the wave rises from the soft ink the tail already
    /// wears, and its crest leans towards the wordmark's blue — brand in
    /// light, sky in dark.
    ///
    /// Tuned per appearance, because the two do not read alike. Brand blue
    /// mixed into near-black ink reads as a dark blue and needs 40 % before
    /// the crest is seen as tinted at all; sky in white needs only a quarter.
    /// The resting emphasis is lower in light (0.32 of ink over the #E2E4E8
    /// backdrop is a grey near 0.63, about 2:1 — faint but legible for the
    /// seconds it lasts) than in dark (0.36 of white over #171717, about
    /// 3.3:1), which is what gives the crest its headroom in both.
    private var style: PolishWaveStyle {
        PolishWaveStyle(
            ink: KBTheme.ink(dark), softInk: KBTheme.inkSoft(dark),
            tint: KBTheme.wordmark(dark),
            tintAmount: dark ? 0.25 : 0.40,
            restingOpacity: dark ? 0.36 : 0.32,
            fontSize: Self.fontSize)
    }

    private var joined: String { PolishWave.transcript(settled: tail, unsettled: partial) }
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
            // The words sit flush with the slot's leading edge and, when short,
            // its foot, so the scroll view's own clip would shave the copy
            // wash's outset off those two sides. The clip moves out by exactly
            // that much on the sides and the foot — into the pane's side margin
            // and the gap above the deck, where nothing else is drawn — and
            // stays at the top, where the lines scrolled out of view go.
            .scrollClipDisabled()
            .clipShape(
                OutsetRect(
                    leading: TranscriptText.washOutset, bottom: TranscriptText.washOutset,
                    trailing: TranscriptText.washOutset))
        }
    }
}

/// A rectangle grown past the view's bounds on the given sides — a clip that
/// lets a few points of drawing out without letting everything out.
private struct OutsetRect: Shape {
    var leading: CGFloat = 0
    var bottom: CGFloat = 0
    var trailing: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        Path(
            CGRect(
                x: rect.minX - leading, y: rect.minY,
                width: rect.width + leading + trailing, height: rect.height + bottom))
    }
}
