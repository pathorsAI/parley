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

/// What a cap is cut to. Characters keep UIKit's rounded rectangle; the
/// function keys around them — shift, delete, `123`, the globe, space, return
/// and the mode key — are pills, which is how the two families stay tellable
/// apart at a glance when both carry the same soft shadow.
enum KeyShape {
    case cap
    case pill
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

    init(width: CGFloat, columns: Int = 10) {
        let content = max(width - KBMetrics.sideInset * 2, 1)
        unit = (content - KBMetrics.keyGap * CGFloat(columns - 1)) / CGFloat(columns)
        wide = (3 * unit + KBMetrics.keyGap) / 2
    }

    /// The half-key iOS insets the QWERTY home row by — and exactly what centres
    /// a ten-key 注音 row under the eleven-key one above it.
    var halfKey: CGFloat { (unit + KBMetrics.keyGap) / 2 }

    /// The mode key. A `wide` key on a 320pt SE comes out at 42pt, under the
    /// 44pt minimum target — so this one key takes its floor from the metrics
    /// table and the difference comes out of the space bar, which is the only
    /// key in the row with slack to give.
    var mode: CGFloat { max(wide, KBMetrics.modeKeyWidth) }
}

/// A key cap: 7pt corners on a character, a pill on a function key, over two
/// stacked soft shadows in both appearances.
///
/// It used to be 5pt corners and a single hard 1pt shadow that was switched off
/// entirely in dark mode — the copy of UIKit's own cap. The softer pair reads as
/// Parley's rather than as a slightly-wrong system keyboard, and dark mode gets
/// a shadow at all, which it did not before.
struct KeyCap: View {
    let dark: Bool
    let tint: KeyTint
    var shape: KeyShape = .cap
    let pressed: Bool

    var body: some View {
        Group {
            switch shape {
            case .cap:
                RoundedRectangle(cornerRadius: KBMetrics.keyRadius, style: .continuous)
                    .fill(fill)
            case .pill:
                Capsule().fill(fill)
            }
        }
        .shadow(color: KBTheme.capShadowNear(dark), radius: 1, x: 0, y: 1)
        .shadow(color: KBTheme.capShadowFar(dark), radius: 3, x: 0, y: 2)
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
/// darken and shrink under the finger the way system keys do.
/// `.buttonStyle(.plain)` alone gives no feedback at all, which is what made the
/// keys feel dead.
///
/// `onPressDown` fires the moment the finger lands, which `action` — a button's
/// touch-*up* — cannot: the record button's haptic has to arrive with the press,
/// not after it. It never changes when a character is typed; only `action` does
/// that.
struct PressableButton<Content: View>: View {
    let action: () -> Void
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
            // Two animation scopes, not one: the inner keeps the fill swap on
            // exactly the ease it always had, the outer gives the scale its
            // spring on the way back up.
            content(configuration.isPressed)
                .animation(KBMetrics.pressDown, value: configuration.isPressed)
                .scaleEffect(configuration.isPressed ? KBMetrics.pressScale : 1)
                .animation(
                    configuration.isPressed ? KBMetrics.pressDown : KBMetrics.pressUp,
                    value: configuration.isPressed
                )
                .onChange(of: configuration.isPressed) { _, isPressed in
                    if isPressed { onPressDown?() }
                }
        }
    }
}

/// Owns the timers behind a hold-to-repeat key. A small class rather than
/// `@State` timers because the repeat has to keep firing from outside the view
/// update cycle, and because `stop()` must be able to run from `deinit` when
/// the pane is swapped out mid-press.
final class KeyRepeater: ObservableObject {
    /// The system's own delete key waits about four tenths of a second before
    /// it starts running, then deletes roughly ten times a second.
    private static let initialDelay: TimeInterval = 0.4
    private static let interval: TimeInterval = 0.1

    private var timer: Timer?

    func start(_ tick: @escaping () -> Void) {
        stop()
        timer = Timer.scheduledTimer(withTimeInterval: Self.initialDelay, repeats: false) {
            [weak self] _ in
            guard let self else { return }
            tick()
            self.timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) {
                _ in tick()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    deinit { timer?.invalidate() }
}

/// A key that fires once on touch-down and then keeps firing while held, like
/// the system delete key. It can't be a `Button`: a button only reports on
/// touch-up, so a hold would be silent until the finger left. The drag gesture
/// with a zero minimum distance is the standard way to get touch-down and
/// touch-up out of SwiftUI, and it also lets go of the touch cleanly when the
/// pane's swipe gesture takes over.
struct RepeatingKey<Content: View>: View {
    let action: () -> Void
    @ViewBuilder var content: (Bool) -> Content

    @State private var pressed = false
    @StateObject private var repeater = KeyRepeater()

    var body: some View {
        content(pressed)
            .contentShape(Rectangle())
            // The same two scopes as `PressableButton`: these keys never go
            // through the button style, so the press feedback has to be spelled
            // out here too or delete would be the one dead key on the board.
            .animation(KBMetrics.pressDown, value: pressed)
            .scaleEffect(pressed ? KBMetrics.pressScale : 1)
            .animation(pressed ? KBMetrics.pressDown : KBMetrics.pressUp, value: pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed else { return }
                        pressed = true
                        action()
                        repeater.start(action)
                    }
                    .onEnded { _ in
                        pressed = false
                        repeater.stop()
                    }
            )
            .onDisappear { repeater.stop() }
    }
}

/// One cap, one label, one action — the key every typing pane is built out of.
///
/// `width == nil` lets the key stretch to share whatever the row has left over,
/// which is how space ends up at roughly its system width without anyone naming
/// a number for it. `height` is a parameter because the 注音 plane fits five
/// rows into the four rows' worth of space QWERTY uses.
struct KeyButton<Label: View>: View {
    let dark: Bool
    var tint: KeyTint = .letter
    /// Characters keep the rounded cap; every function key is a pill.
    var shape: KeyShape = .cap
    var width: CGFloat?
    var height: CGFloat = KBMetrics.keyHeight
    var ink: Color?
    let action: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        PressableButton(action: action) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: tint, shape: shape, pressed: pressed)
                label().foregroundStyle(ink ?? KBTheme.ink(dark))
            }
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
        }
    }
}

/// Delete, with the system key's hold-to-repeat. Its own type rather than a
/// `KeyButton` because a `Button` only reports on touch-up — see `RepeatingKey`.
struct DeleteKey: View {
    let dark: Bool
    var width: CGFloat?
    var height: CGFloat = KBMetrics.keyHeight
    let action: () -> Void

    var body: some View {
        RepeatingKey(action: action) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: .alt, shape: .pill, pressed: pressed)
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
struct GlobeKey: View {
    weak var controller: UIInputViewController?
    let dark: Bool
    /// The voice pane draws its controls as discs, the letter pane as caps.
    var round = false

    @State private var pressed = false

    var body: some View {
        ZStack {
            if round {
                ControlDisc(dark: dark, pressed: pressed)
            } else {
                KeyCap(dark: dark, tint: .alt, shape: .pill, pressed: pressed)
            }
            Image(systemName: "globe")
                .font(.system(size: round ? 16 : 17, weight: .regular))
                .foregroundStyle(round ? KBTheme.inkSoft(dark) : KBTheme.ink(dark))
                .accessibilityHidden(true)
            InputModeSwitchButton(controller: controller, pressed: $pressed)
        }
        // Its own press feedback, for the same reason `RepeatingKey` has one:
        // the touches belong to a UIKit button, so the cap would otherwise be
        // the only key on the row that doesn't move.
        .animation(KBMetrics.pressDown, value: pressed)
        .scaleEffect(pressed ? KBMetrics.pressScale : 1)
        .animation(pressed ? KBMetrics.pressDown : KBMetrics.pressUp, value: pressed)
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
        @objc func down() { report(true) }
        @objc func up() { report(false) }
    }
}

/// What a pane is called, in one place: the strip names the pane you are on,
/// the mode key names the one you are going to, and the menu names all of them.
///
/// 注音 keeps its own name in both localizations — the keys on that pane *are*
/// 注音, and nothing an English word could say would identify it faster.
extension KeyboardPane {
    /// The short name, as it goes on a key cap.
    var name: Text {
        switch self {
        case .voice: return Text("Voice")
        case .english: return Text("English")
        case .zhuyin: return Text(verbatim: "注音")
        }
    }

    /// The long name, for VoiceOver and for the mode key's menu, where there is
    /// room to say which of the three kinds of thing this is.
    var label: Text {
        switch self {
        case .voice: return Text("Voice dictation")
        case .english: return Text("English keyboard")
        case .zhuyin: return Text("Bopomofo keyboard")
        }
    }
}

/// The key that changes pane — the headline of the bottom row.
///
/// Before it, the only way across was a full-width swipe nobody found and a row
/// of 5pt dots far under the 44pt minimum target. This is the ordinary answer:
/// a key that says where it goes, in the same corner of every pane so the hand
/// can learn it.
///
/// **Tap advances, hold picks.** `primaryAction` is the tap — one pane along,
/// wrapping at the end so the key is never a dead one — and the menu is the long
/// press, listing every pane with the current one ticked, for jumping straight
/// across a three-pane track. It is the same pairing the system's own globe has,
/// which is why it needs no explaining.
///
/// It is labelled with the pane it will take you to, like the system's
/// `123`/`ABC` key: a key captioned with what you are already looking at is the
/// one caption that tells you nothing.
struct ModeKey: View {
    @ObservedObject var bridge: KeyboardBridge
    let dark: Bool
    var width: CGFloat?
    var height: CGFloat = KBMetrics.keyHeight
    /// The voice pane draws its controls as discs, the typing panes as caps.
    var round = false

    /// A `Menu` reports no pressed state of its own, so the one genuinely new
    /// key would have been the only dead key on a keyboard whose point is that
    /// pressing things feels like something. A zero-distance drag alongside the
    /// menu's own recognizer supplies it.
    ///
    /// `@GestureState` rather than `@State` because it resets itself when the
    /// gesture ends *or is cancelled* — and the menu opening under the finger is
    /// exactly the cancellation that would otherwise leave the cap stuck down.
    @GestureState private var pressed = false

    var body: some View {
        Menu {
            ForEach(bridge.panes, id: \.self) { pane in
                Button(action: { bridge.setPane(pane) }) {
                    if pane == bridge.pane {
                        Label { pane.label } icon: { Image(systemName: "checkmark") }
                    } else {
                        pane.label
                    }
                }
            }
        } label: {
            ZStack {
                if round {
                    ControlDisc(dark: dark, pressed: pressed)
                } else {
                    KeyCap(dark: dark, tint: .alt, shape: .pill, pressed: pressed)
                }
                bridge.nextPane.name
                    .font(.system(size: round ? 13 : 15))
                    // "English" is wider than a 44pt key on a 320pt SE. It
                    // shrinks rather than truncating: half a pane name is worse
                    // than a small one.
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 4)
                    .foregroundStyle(round ? KBTheme.inkSoft(dark) : KBTheme.ink(dark))
            }
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .contentShape(Rectangle())
            // The same two scopes every other key uses: the fill on the ease it
            // has always had, the scale springing back on release.
            .animation(KBMetrics.pressDown, value: pressed)
            .scaleEffect(pressed ? KBMetrics.pressScale : 1)
            .animation(pressed ? KBMetrics.pressDown : KBMetrics.pressUp, value: pressed)
            // Simultaneous, so it only *observes* the touch: the tap still
            // reaches `primaryAction` and the hold still opens the menu.
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .updating($pressed) { _, state, _ in state = true }
            )
        } primaryAction: {
            bridge.advancePane()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Switch input mode"))
        .accessibilityValue(bridge.nextPane.name)
    }
}
