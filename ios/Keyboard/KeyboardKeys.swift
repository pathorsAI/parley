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

/// A key cap. 5pt corners and a 1pt hard shadow, which is what UIKit draws.
struct KeyCap: View {
    let dark: Bool
    let tint: KeyTint
    let pressed: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(fill)
            .shadow(color: .black.opacity(dark ? 0 : 0.28), radius: 0, x: 0, y: 1)
    }

    private var fill: Color {
        switch tint {
        case .letter: return pressed ? KBTheme.keyPressed(dark) : KBTheme.key(dark)
        case .alt: return pressed ? KBTheme.keyAltPressed(dark) : KBTheme.keyAlt(dark)
        case .accent: return pressed ? KBTheme.accent.opacity(0.75) : KBTheme.accent
        }
    }
}

/// A button that reports its own pressed state, so keys and the mic control can
/// darken under the finger the way system keys do. `.buttonStyle(.plain)` alone
/// gives no feedback at all, which is what made the keys feel dead.
struct PressableButton<Content: View>: View {
    let action: () -> Void
    @ViewBuilder var content: (Bool) -> Content

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(PressStyle(content: content))
    }

    private struct PressStyle<C: View>: ButtonStyle {
        @ViewBuilder var content: (Bool) -> C
        func makeBody(configuration: Configuration) -> some View {
            content(configuration.isPressed)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
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
            .animation(.easeOut(duration: 0.08), value: pressed)
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

/// The globe.
///
/// Parley ships no Bopomofo engine — a keyboard extension can't reach the
/// system Chinese input engine and we are not bundling our own — so a user who
/// wants 注音 has to be able to leave, on *every* device rather than only where
/// `needsInputModeSwitchKey` is true. That makes this key load-bearing.
///
/// It is a real `UIButton` because `handleInputModeList(from:with:)` demands the
/// live `UIEvent` from a control action; a SwiftUI gesture has no event to hand
/// it. Wiring the whole touch sequence to that one selector is UIKit's own
/// globe behaviour: a tap advances to the next keyboard, a hold presents the
/// system keyboard picker, from which 注音 is one more tap.
struct GlobeKey: View {
    weak var controller: UIInputViewController?
    let dark: Bool

    @State private var pressed = false

    var body: some View {
        ZStack {
            KeyCap(dark: dark, tint: .alt, pressed: pressed)
            Image(systemName: "globe")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(KBTheme.ink(dark))
                .accessibilityHidden(true)
            InputModeSwitchButton(controller: controller, pressed: $pressed)
        }
        .animation(.easeOut(duration: 0.08), value: pressed)
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
            width: proposal.width ?? KBMetrics.quickKeyWidth,
            height: proposal.height ?? KBMetrics.keyHeight)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        var report: (Bool) -> Void = { _ in }
        @objc func down() { report(true) }
        @objc func up() { report(false) }
    }
}
