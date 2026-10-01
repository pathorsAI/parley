import ParleyKit
import SwiftUI
import UIKit

/// The pieces every key on this keyboard is built from: the cap, the two press
/// behaviours (tap and hold-to-repeat), and the globe.
///
/// They live apart from the panes because both panes use them and because a key
/// cap is the one place where "look like the system keyboard" is a hard
/// requirement — the moment a cap's corner radius or press feedback drifts from
/// UIKit's, the whole keyboard reads as broken even when the layout is right.

/// Which family a cap belongs to. iOS splits its keys into the letters (light
/// caps) and everything else (duller caps), and inverts the press feedback
/// between them; `accent` is the tinted return key.
enum KeyTint {
    case letter
    case alt
    case accent
}

/// Every width on a key row, derived from the widest row's key count: one key is
/// the unit and every wide key is expressed in units, so the rows line up on a
/// 320pt SE and a 440pt Pro Max alike.
///
/// `columns` is 10 for QWERTY and 11 for 大千 — 注音's top row is
/// `1234567890-`, because the 41st key is `ㄦ` and 兒/二/而/耳 are not optional.
struct KeyRowMetrics {
    /// One ordinary key.
    let unit: CGFloat
    /// Shift, delete, `123`, `ABC`, return — one and a half keys, which is what
    /// falls out of asking three keys and a gap to cover two of them.
    let wide: CGFloat
    /// Two and a half keys: what the system 注音 keyboard gives `123` and return
    /// on a bottom row that has no delete key to make room for.
    let extraWide: CGFloat

    init(width: CGFloat, columns: Int = 10) {
        let content = max(width - KBMetrics.sideInset * 2, 1)
        unit = (content - KBMetrics.keyGap * CGFloat(columns - 1)) / CGFloat(columns)
        wide = (3 * unit + KBMetrics.keyGap) / 2
        extraWide = (5 * unit + 3 * KBMetrics.keyGap) / 2
    }

    /// The half-key iOS insets the QWERTY home row by.
    var halfKey: CGFloat { (unit + KBMetrics.keyGap) / 2 }
}

/// How far each key in one row reaches past its cap to catch a touch.
///
/// **Every point of a typing pane belongs to a key.** The caps are drawn with
/// gaps between them, but on the system keyboard a finger that lands in a gap,
/// in the half-key strip beside `a`, or in the margin above the top row still
/// types the nearest key. Parley's keys used to hit-test only their drawn cap,
/// so all of that — about a third of the pane on a 390pt phone — fell through
/// to the track, where only the swipe listens, and the tap was lost. A fast
/// typist lands in a gap many times a sentence; that was most of "it doesn't
/// feel like the real keyboard".
///
/// So each key's touch target is its cap plus its share of the space around
/// it: half the gap to each neighbour, half the row spacing above and below,
/// and — for the keys at the ends of a row, the top row and the bottom row —
/// everything out to the pane's edge. Together the targets tile the pane.
///
/// The reach is a hit shape (`KeyTarget`), not layout: the rows keep their
/// spacing and padding and the caps are laid out exactly as before. Growing
/// the keys' frames instead and laying the rows out edge to edge moved the
/// 注音 caps by a pixel — its 34.6pt rows round to the pixel grid differently
/// once they are nested one level deeper — and a keyboard whose keys shift
/// when nothing about them changed is exactly the wrong way round. The callout
/// and the press shading follow the cap, as they always did.
struct RowReach {
    /// Above and below every key in the row.
    var top: CGFloat
    var bottom: CGFloat
    /// Beyond the first key's cap, out to the pane's leading edge.
    var leadingEdge: CGFloat
    /// Beyond the last key's cap, out to the pane's trailing edge.
    var trailingEdge: CGFloat

    /// Row `index` of `count` rows `spacing` apart, in a pane whose top and
    /// bottom margins are `KBMetrics.paneTop` and `KBMetrics.paneBottom`, with
    /// the row's first and last caps `leading` and `trailing` in from the
    /// pane's sides (the screen-edge margin, plus any inset or stagger).
    init(
        row index: Int, of count: Int, spacing: CGFloat,
        leading: CGFloat = KBMetrics.sideInset, trailing: CGFloat = KBMetrics.sideInset
    ) {
        top = index == 0 ? KBMetrics.paneTop : spacing / 2
        bottom = index == count - 1 ? KBMetrics.paneBottom : spacing / 2
        leadingEdge = leading + Self.edgeOverhang
        trailingEdge = trailing + Self.edgeOverhang
    }

    /// How far past the pane's side edges the end keys reach, so a row drawn a
    /// few points off its computed inset still leaves no dead strip at the
    /// edge — the 注音 plane's fourth row does sit 3pt right of the others (see
    /// `ZhuyinPane`). Every pane cuts its keys' targets at its own edge with a
    /// `contentShape`, so this never reaches into the pane beside it on the
    /// track; without that cut, a tap beside `p` typed the 注音 pane's `ㄅ`.
    /// Not applied above the top row or below the bottom one: above is the
    /// strip, whose own buttons must keep their touches.
    static let edgeOverhang: CGFloat = KBMetrics.keyGap

    /// The reach of one key, by where it sits in the row.
    func key(first: Bool = false, last: Bool = false) -> EdgeInsets {
        EdgeInsets(
            top: top, leading: first ? leadingEdge : KBMetrics.keyGap / 2,
            bottom: bottom, trailing: last ? trailingEdge : KBMetrics.keyGap / 2)
    }

    /// The reach of key `index` of `count` in the row.
    func key(_ index: Int, of count: Int) -> EdgeInsets {
        key(first: index == 0, last: index == count - 1)
    }
}

/// A key's touch target: its frame grown by its reach on each side. Used as a
/// `contentShape`, which SwiftUI hit-tests even where it extends past the
/// view's own frame; nothing draws it.
struct KeyTarget: Shape {
    var reach: EdgeInsets

    func path(in rect: CGRect) -> Path {
        Path(
            CGRect(
                x: rect.minX - reach.leading, y: rect.minY - reach.top,
                width: rect.width + reach.leading + reach.trailing,
                height: rect.height + reach.top + reach.bottom))
    }
}

extension EdgeInsets {
    /// The same insets pointing the other way, for a view that has to overhang
    /// its layout frame by them.
    var negated: EdgeInsets {
        EdgeInsets(top: -top, leading: -leading, bottom: -bottom, trailing: -trailing)
    }
}

/// The system keyboard's click.
///
/// `playInputClick` plays only when the input view on screen adopts
/// `UIInputViewAudioFeedback` — `KeyboardInputView` does — and only when the
/// user has Keyboard Clicks switched on in Settings › Sounds & Haptics, which
/// it checks by itself. So every key calls this on touch-down, like the system
/// keys, and the user's setting decides.
///
/// No haptic goes with it. The system keyboard's key haptic is a separate
/// setting (Keyboard Feedback › Haptic) that a third-party keyboard cannot
/// read, and playing one regardless would buzz on every letter for the people
/// who turned it off.
enum KeyClick {
    static func play() { UIDevice.current.playInputClick() }
}

/// A key cap. 5pt corners and a 1pt hard shadow, which is what UIKit draws.
struct KeyCap: View {
    let dark: Bool
    let tint: KeyTint
    let pressed: Bool

    /// The 1pt shadow is the cap's own shape, one point lower, drawn under it —
    /// which is exactly what a zero-radius `.shadow` renders, without making
    /// every one of the forty-odd caps an offscreen shadow pass. It was also
    /// still being applied in dark mode, at opacity zero; there the underlay
    /// is simply not in the tree. Its alpha is scaled by the fill's, as a
    /// shadow's is, so the one translucent fill — the pressed accent — casts
    /// what it did before.
    var body: some View {
        ZStack {
            if !dark {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(.black.opacity(0.28 * fillOpacity))
                    .offset(y: 1)
            }
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(fill)
        }
    }

    /// How opaque `fill` is: 0.75 for the pressed accent, 1 for the rest.
    private var fillOpacity: Double {
        tint == .accent && pressed ? 0.75 : 1
    }

    private var fill: Color {
        switch tint {
        case .letter: return pressed ? KBTheme.keyPressed(dark) : KBTheme.key(dark)
        case .alt: return pressed ? KBTheme.keyAltPressed(dark) : KBTheme.keyAlt(dark)
        case .accent: return pressed ? KBTheme.accent.opacity(0.75) : KBTheme.accent
        }
    }
}

/// The voice pane's counterpart to `KeyCap`: a flat translucent disc.
///
/// The voice pane is a control panel, not a keyboard, so its buttons carry none
/// of the cap treatment — no raised fill, no hard shadow, no inverted press.
/// Compose it with `PressableButton` or `RepeatingKey` the same way a cap is.
struct ControlDisc: View {
    let dark: Bool
    let pressed: Bool

    var body: some View {
        Circle()
            .fill(pressed ? KBTheme.controlPressed(dark) : KBTheme.control(dark))
    }
}

/// A button that reports its own pressed state, so keys and the mic control can
/// darken under the finger the way system keys do. `.buttonStyle(.plain)` alone
/// gives no feedback at all, which is what made the keys feel dead.
struct PressableButton<Content: View>: View {
    let action: () -> Void
    /// Fired as the finger lands, before `action`, for the callers that need
    /// the press itself rather than the tap: the haptics on the record button
    /// and on ✕. A confirmation that arrives on the release confirms nothing.
    var onPressDown: (() -> Void)?
    @ViewBuilder var content: (Bool) -> Content

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(PressStyle(content: content, onPressDown: onPressDown))
    }

    private struct PressStyle<C: View>: ButtonStyle {
        @ViewBuilder var content: (Bool) -> C
        var onPressDown: (() -> Void)?

        func makeBody(configuration: Configuration) -> some View {
            content(configuration.isPressed)
                // Pressed on the frame the finger lands, like a system key;
                // only the release eases out. Fading the press in over 80 ms
                // made every key feel a beat behind the finger.
                .animation(
                    configuration.isPressed ? nil : .easeOut(duration: 0.1),
                    value: configuration.isPressed)
                .onChange(of: configuration.isPressed) { _, isPressed in
                    if isPressed { onPressDown?() }
                }
        }
    }
}

/// Owns the timer behind a hold-to-repeat key. A small class rather than
/// `@State` timers because the repeat has to keep firing from outside the view
/// update cycle, and because `stop()` must be able to run from `deinit` when
/// the pane is swapped out mid-press.
///
/// The pace is `DeleteRepeat`'s (ParleyKit): half a second before the first
/// repeat, a tenth of a second between repeats, twice that pace after about a
/// second, and a word at a time after twenty characters. Each repeat is told
/// its number so the key can ask what it should delete.
///
/// One-shot timers, each scheduling the next, because the interval changes as
/// the hold goes on. They are added to the main run loop in `.common` modes
/// rather than the default mode `scheduledTimer` uses, so a repeat does not
/// stall while the run loop is tracking — the drag gesture behind the key is
/// itself a tracking interaction.
final class KeyRepeater: ObservableObject {
    private var timer: Timer?
    /// Repeats fired in the current hold; 0 while none have.
    private(set) var repeats = 0

    func start(_ tick: @escaping (Int) -> Void) {
        stop()
        schedule(tick)
    }

    private func schedule(_ tick: @escaping (Int) -> Void) {
        let next = repeats + 1
        let timer = Timer(timeInterval: DeleteRepeat.delay(beforeRepeat: next), repeats: false) {
            [weak self] _ in
            guard let self else { return }
            self.repeats = next
            tick(next)
            self.schedule(tick)
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Ends the hold. Says whether it repeated at all, so the key can tell a
    /// tap from a hold on release.
    @discardableResult
    func stop() -> Bool {
        timer?.invalidate()
        timer = nil
        defer { repeats = 0 }
        return repeats > 0
    }

    deinit { timer?.invalidate() }
}

/// A key that fires once on touch-down and then keeps firing while held, like
/// the system delete key. It can't be a `Button`: a button only reports on
/// touch-up, so a hold would be silent until the finger left. The drag gesture
/// with a zero minimum distance is the standard way to get touch-down and
/// touch-up out of SwiftUI.
///
/// `@GestureState` rather than `@State`, because it also resets when the
/// gesture is *cancelled* — which is what happens when the pane track takes
/// the touch over mid-swipe. A cancelled drag never reaches `onEnded`, so the
/// repeater is started and stopped from the state itself, and a swipe that
/// began on ⌫ cannot leave it deleting.
///
/// `action` is the press. `repeatAction`, when given, is each repeat, told its
/// number (see `DeleteRepeat`); without it a repeat is the press again.
/// `onRelease` runs when a hold that repeated ends — not after a plain tap —
/// which is where the work skipped on every repeat is done once. `reach` grows
/// the touch target past the content, as on every other key (`RowReach`).
struct RepeatingKey<Content: View>: View {
    let action: () -> Void
    var repeatAction: ((Int) -> Void)?
    var onRelease: (() -> Void)?
    var reach = EdgeInsets()
    @ViewBuilder var content: (Bool) -> Content

    @GestureState private var pressed = false
    @StateObject private var repeater = KeyRepeater()

    var body: some View {
        content(pressed)
            .contentShape(KeyTarget(reach: reach))
            // Pressed on the frame the finger lands; see `PressableButton`.
            .animation(pressed ? nil : .easeOut(duration: 0.1), value: pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($pressed) { _, state, _ in state = true }
            )
            .onChange(of: pressed) { _, down in
                if down {
                    action()
                    repeater.start { n in
                        if let repeatAction { repeatAction(n) } else { action() }
                    }
                } else {
                    release()
                }
            }
            .onDisappear { release() }
    }

    private func release() {
        if repeater.stop() { onRelease?() }
    }
}

/// One cap, one label, one action — the key every typing pane is built out of.
///
/// `width == nil` lets the key stretch to share whatever the row has left over,
/// which is how space ends up at roughly its system width without anyone naming
/// a number for it. `height` is a parameter because the 注音 plane fits five
/// rows into the four rows' worth of space QWERTY uses.
///
/// `reach` is how far the key's touch target extends past its cap on each
/// side — see `RowReach`. It changes what the key catches, not where it sits.
///
/// Every key clicks on touch-down (`KeyClick`). `onPressDown` is for a key
/// whose action itself belongs on touch-down — shift, as on the system
/// keyboard.
///
/// The label is built once, when the key is, rather than kept as a closure, so
/// that a key whose label is a `Text` — nearly all of them — can be compared.
/// Wrapped in `.equatable()` it is skipped whenever its pane redraws for a
/// reason that did not touch it: shift re-cases the letters, and the other
/// eleven keys on that row need not be re-evaluated to find that out.
struct KeyButton<Label: View>: View {
    let dark: Bool
    var tint: KeyTint = .letter
    var width: CGFloat?
    var height: CGFloat = KBMetrics.keyHeight
    var reach: EdgeInsets
    var ink: Color?
    var callout: String?
    let action: () -> Void
    var onPressDown: (() -> Void)?
    let label: Label

    init(
        dark: Bool, tint: KeyTint = .letter, width: CGFloat? = nil,
        height: CGFloat = KBMetrics.keyHeight, reach: EdgeInsets = EdgeInsets(),
        ink: Color? = nil, callout: String? = nil,
        action: @escaping () -> Void, onPressDown: (() -> Void)? = nil,
        @ViewBuilder label: () -> Label
    ) {
        self.dark = dark
        self.tint = tint
        self.width = width
        self.height = height
        self.reach = reach
        self.ink = ink
        self.callout = callout
        self.action = action
        self.onPressDown = onPressDown
        self.label = label()
    }

    var body: some View {
        PressableButton(
            action: action,
            onPressDown: {
                KeyClick.play()
                onPressDown?()
            }
        ) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: tint, pressed: pressed)
                label.foregroundStyle(ink ?? KBTheme.ink(dark))
            }
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .anchorPreference(key: PressedKeys.self, value: .bounds) { bounds in
                guard pressed, let callout else { return [] }
                return [PressedKey(label: callout, bounds: bounds)]
            }
            // The whole target takes the touch, not just the painted cap.
            .contentShape(KeyTarget(reach: reach))
        }
    }
}

/// Everything a key draws. The action is deliberately left out: on every key
/// in this keyboard it is a function of what the key shows (a letter types the
/// letter its label shows) or of state read when it fires (shift, the plane,
/// the bridge), so two keys that look the same do the same thing.
extension KeyButton: Equatable where Label: Equatable {
    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.tint == b.tint && a.width == b.width && a.height == b.height
            && a.reach == b.reach && a.ink == b.ink && a.callout == b.callout
            && a.label == b.label
    }
}

/// Delete, with the system key's hold-to-repeat. Its own type rather than a
/// `KeyButton` because a `Button` only reports on touch-up — see `RepeatingKey`.
///
/// `action` is one delete, with everything a delete refreshes. A key that
/// passes `repeatAction` gets the system key's whole run instead: each repeat
/// is handed the `DeleteRepeat.Unit` its number calls for and is expected to
/// skip the per-keystroke refresh, and `onRelease` does that refresh once when
/// the hold ends. Without it every repeat is `action` again, at the same pace.
/// It clicks on the press and on every repeat, as the system key does.
///
/// `Equatable` on its looks, like `KeyButton`; every delete key's action is
/// the same backspace.
struct DeleteKey: View, Equatable {
    let dark: Bool
    var width: CGFloat?
    var height: CGFloat = KBMetrics.keyHeight
    var reach = EdgeInsets()
    let action: () -> Void
    var repeatAction: ((DeleteRepeat.Unit) -> Void)?
    var onRelease: (() -> Void)?

    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.width == b.width && a.height == b.height && a.reach == b.reach
    }

    var body: some View {
        RepeatingKey(
            action: {
                KeyClick.play()
                action()
            },
            repeatAction: { n in
                KeyClick.play()
                if let repeatAction {
                    repeatAction(DeleteRepeat.unit(forRepeat: n))
                } else {
                    action()
                }
            },
            onRelease: onRelease,
            reach: reach
        ) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: .alt, pressed: pressed)
                Image(systemName: "delete.left")
                    .font(.system(size: 19, weight: .regular))
                    .foregroundStyle(KBTheme.ink(dark))
            }
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
        }
        .accessibilityLabel(Text("Delete"))
    }
}

/// The globe, shown only where the system asks for one.
///
/// App Review 4.4.1 asks that a keyboard never trap the user, so there has to
/// be a way out to another keyboard. This key used to be drawn on *every*
/// device to guarantee that exit, which was a mistake: from iPhone X onwards
/// iOS draws the Emoji/Globe and Dictation keys itself, in the strip beneath a
/// raised keyboard, **including over custom keyboards**, and the HIG asks
/// explicitly not to repeat them ("Don't duplicate system-provided keyboard
/// features … avoid causing confusion by repeating them in your keyboard").
/// `needsInputModeSwitchKey` is how the system says which case it is in, so
/// every pane follows it rather than overriding it.
///
/// It is a real `UIButton` because `handleInputModeList(from:with:)` demands the
/// live `UIEvent` from a control action; a SwiftUI gesture has no event to hand
/// it. Wiring the whole touch sequence to that one selector is UIKit's own
/// globe behaviour: a tap advances to the next keyboard, a hold presents the
/// system keyboard picker.
///
/// On a typing pane it takes a `reach` like every other key (see `RowReach`).
/// A `contentShape` means nothing to a `UIButton`, so the transparent button
/// itself is made that much bigger and overhangs the cap by it — negative
/// padding, so the key's own frame, and every cap around it, stay where they
/// were — and the gap beside the globe switches keyboards rather than dropping
/// the touch. The voice pane passes none.
struct GlobeKey: View {
    weak var controller: UIInputViewController?
    let dark: Bool
    /// The voice pane draws its controls as discs, the letter pane as caps.
    var round = false
    var reach = EdgeInsets()

    @State private var pressed = false

    var body: some View {
        ZStack {
            if round {
                ControlDisc(dark: dark, pressed: pressed)
            } else {
                KeyCap(dark: dark, tint: .alt, pressed: pressed)
            }
            Image(systemName: "globe")
                .font(.system(size: round ? 16 : 17, weight: .regular))
                .foregroundStyle(round ? KBTheme.inkSoft(dark) : KBTheme.ink(dark))
                .accessibilityHidden(true)
            InputModeSwitchButton(controller: controller, pressed: $pressed)
                .padding(reach.negated)
        }
        // Pressed on the frame the finger lands; see `PressableButton`.
        .animation(pressed ? nil : .easeOut(duration: 0.1), value: pressed)
    }
}

/// The transparent `UIButton` sitting on top of `GlobeKey`'s cap. It draws
/// nothing; SwiftUI draws the cap and the glyph, and this only carries the
/// touches to UIKit and reports the press back so the cap can follow.
private struct InputModeSwitchButton: UIViewRepresentable {
    weak var controller: UIInputViewController?
    @Binding var pressed: Bool

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.backgroundColor = .clear
        button.accessibilityLabel = String(localized: "Next keyboard")
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentHuggingPriority(.defaultLow, for: .vertical)

        if let controller {
            button.addTarget(
                controller,
                action: #selector(UIInputViewController.handleInputModeList(from:with:)),
                for: .allTouchEvents)
        }
        button.addTarget(
            context.coordinator, action: #selector(Coordinator.down),
            for: [.touchDown, .touchDragEnter])
        button.addTarget(
            context.coordinator, action: #selector(Coordinator.up),
            for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.report = { pressed = $0 }
    }

    /// Fill whatever the cap was given; a content-less `UIButton` has no
    /// intrinsic size of its own to fall back on.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIButton, context: Context)
        -> CGSize?
    {
        CGSize(
            width: proposal.width ?? KBMetrics.roundKey,
            height: proposal.height ?? KBMetrics.keyHeight)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        var report: (Bool) -> Void = { _ in }
        @objc func down() {
            KeyClick.play()
            report(true)
        }
        @objc func up() { report(false) }
    }
}
