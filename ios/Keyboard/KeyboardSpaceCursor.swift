import ParleyKit
import SwiftUI
import UIKit

/// The space bar, which is also the keyboard's trackpad.
///
/// Held still for `SpaceCursor.holdDelay`, it stops being a key: every other
/// cap on the pane goes blank, the bar says what it does now, and sliding the
/// same finger walks the caret through the text a character at a time, the
/// way the system keyboard's does. Letting go puts the keys back and types
/// nothing. A quick tap is the space bar it always was — a space, or on the
/// 注音 pane the first tone and then the confirm key — and so is a hold while
/// a 注音 reading is pending, where space is still busy composing. What a
/// press turns into, and how far a drag moves the caret, is `SpaceCursor` and
/// `CaretWalk` in ParleyKit; this file only feeds them touches and does what
/// they say.
///
/// **One gesture, not a button plus a gesture.** The obvious build is to keep
/// the `KeyButton` and hang a long-press on it, but then the button's own
/// touch-up would type a space at the end of every trackpad drag that ended
/// on the bar, and the two would have to be talked out of each other in
/// whichever order SwiftUI delivers them. So the bar is a `DragGesture` with
/// no minimum distance, as `RepeatingKey` is, and the tap is decided on
/// release by the same machine that decides the hold.
///
/// **VoiceOver is unchanged.** The bar is one element labelled "Space" with
/// the button trait, and activating it types a space through the same
/// `bridge.space()` the tap does — what the button it replaced offered. The
/// trackpad is touch-only; VoiceOver users already move the caret with the
/// rotor.
///
/// `Equatable` on its looks, like `KeyButton`: its action is always the
/// bridge's space, and the bridge is the same object for the process's life.
struct SpaceKey: View, Equatable {
    /// Actions only. Not observed; see `ZhuyinPane`.
    let bridge: KeyboardBridge
    let dark: Bool
    var height: CGFloat = KBMetrics.keyHeight
    /// See `RowReach`.
    var reach = EdgeInsets()

    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.height == b.height && a.reach == b.reach
    }

    /// `@GestureState` for the reason `RepeatingKey` uses it: it also resets
    /// when the touch is *cancelled* — the pane track taking it for a swipe —
    /// which `onEnded` never hears about.
    @GestureState private var touching = false
    @StateObject private var press = SpacePress()

    var body: some View {
        let steering = press.steering
        ZStack {
            KeyCap(dark: dark, tint: .letter, pressed: touching && !steering)
            if steering {
                // Two lines at most, and allowed to shrink a little: on a 320pt
                // SE the 注音 bar is about 81pt wide, which the English hint
                // does not fit on one line at any size worth reading.
                Text("Slide to move the cursor")
                    .font(.system(size: 12))
                    .foregroundStyle(KBTheme.inkSoft(dark))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.75)
                    .padding(.horizontal, 4)
            } else {
                Text("Space").font(.system(size: 15))
                    .foregroundStyle(KBTheme.ink(dark))
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        // The whole target takes the touch, not just the painted cap.
        .contentShape(KeyTarget(reach: reach))
        .onGeometryChange(for: CGSize.self) { $0.size } action: { press.size = $0 }
        // Pressed on the frame the finger lands; see `PressableButton`.
        .animation(touching ? nil : .easeOut(duration: 0.1), value: touching)
        .gesture(
            DragGesture(minimumDistance: 0)
                .updating($touching) { _, state, _ in state = true }
                .onChanged { press.moved($0, bridge: bridge) }
                .onEnded { press.ended($0, reach: reach, bridge: bridge) }
        )
        .onChange(of: touching) { _, down in
            if !down { press.touchWentAway(bridge: bridge) }
        }
        .onDisappear { press.cancel(bridge: bridge) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Space"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { bridge.space() }
    }
}

/// One space bar's press: the `SpaceCursor` machine, the hold timer, and the
/// caret walk for the drag in progress. A small class rather than `@State`
/// for the reason `KeyRepeater` is one — the hold fires from a timer, outside
/// the view update cycle — and so that the touch samples, which arrive many
/// times a second, change nothing SwiftUI watches. Only `steering` is
/// published, and only this key observes it.
final class SpacePress: ObservableObject {
    /// The bar is a trackpad right now: it shows the hint instead of its
    /// label. Published on entering and leaving only.
    @Published private(set) var steering = false

    /// The key's laid-out size, for deciding whether a release landed on it.
    /// Not published: nothing is drawn from it.
    var size: CGSize = .zero

    private var cursor = SpaceCursor()
    private var walk = CaretWalk(before: nil, after: nil)
    private var timer: Timer?
    /// Counts touches, so a cancellation noticed a turn late cannot end a
    /// press that began after it. See `touchWentAway`.
    private var generation = 0

    /// How far past the key's target a finger may lift and still have tapped
    /// it. A button forgives a touch-up a little outside itself, and so does
    /// this — a thumb rolling off the bottom edge of the bar as it lifts is
    /// still a tap.
    private static let releaseTolerance: CGFloat = 16

    func moved(_ value: DragGesture.Value, bridge: KeyboardBridge) {
        let time = value.time.timeIntervalSinceReferenceDate
        if cursor.phase == .idle { began(at: time, bridge: bridge) }
        let steps = cursor.moved(
            dx: value.translation.width, dy: value.translation.height, at: time)
        guard steps != 0 else { return }
        bridge.moveCaret(by: walk.offset(steps: steps))
        if bridge.hasFullAccess { Haptics.caretStepped() }
    }

    func ended(_ value: DragGesture.Value, reach: EdgeInsets, bridge: KeyboardBridge) {
        stopTimer()
        let target = CGRect(origin: .zero, size: size)
            .inset(by: UIEdgeInsets(
                top: -reach.top, left: -reach.leading,
                bottom: -reach.bottom, right: -reach.trailing))
            .insetBy(dx: -Self.releaseTolerance, dy: -Self.releaseTolerance)
        // A key that has not been measured yet takes every release, as the
        // button it replaced would have.
        let inside = size == .zero || target.contains(value.location)
        let release = cursor.release(inside: inside)
        finish(bridge: bridge)
        if release == .space { bridge.space() }
    }

    /// The gesture state reset. After an ordinary release `ended` has already
    /// run and this has nothing to do; when the touch was taken away — the
    /// track claimed it — `ended` never runs, and this is the only notice.
    ///
    /// Deferred a turn of the main queue, because SwiftUI does not promise
    /// that the state's reset reaches `onChange` after `onEnded` rather than
    /// before it, and a cancel that won that race would swallow the tap.
    /// `generation` keeps the deferred cancel to the touch it was about.
    func touchWentAway(bridge: KeyboardBridge) {
        let touch = generation
        DispatchQueue.main.async { [weak self, weak bridge] in
            guard let self, let bridge, self.generation == touch else { return }
            self.cancel(bridge: bridge)
        }
    }

    /// Ends the press without typing anything.
    func cancel(bridge: KeyboardBridge) {
        stopTimer()
        guard cursor.phase != .idle else { return }
        cursor.cancel()
        finish(bridge: bridge)
    }

    private func began(at time: TimeInterval, bridge: KeyboardBridge) {
        generation += 1
        // Every key clicks on touch-down; see `KeyClick`.
        KeyClick.play()
        cursor.touchDown(at: time)
        stopTimer()
        // In `.common` modes, as `KeyRepeater`'s are: the run loop is tracking
        // this very touch, and a default-mode timer would wait for it to end.
        let timer = Timer(timeInterval: SpaceCursor.holdDelay, repeats: false) {
            [weak self, weak bridge] _ in
            guard let self, let bridge else { return }
            self.timer = nil
            self.holdElapsed(bridge: bridge)
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func holdElapsed(bridge: KeyboardBridge) {
        guard cursor.holdElapsed(allowed: bridge.spaceCanSteerCaret) else { return }
        // Read once, here: see `CaretWalk` for why not after every step.
        let context = bridge.caretContext()
        walk = CaretWalk(before: context.before, after: context.after)
        steering = true
        bridge.spaceCursor.begin()
        if bridge.hasFullAccess { Haptics.caretSteeringStarted() }
    }

    private func finish(bridge: KeyboardBridge) {
        if steering { steering = false }
        bridge.spaceCursor.end()
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    deinit { timer?.invalidate() }
}

/// Whether the space bar is steering the caret, for the two things outside
/// the bar that have to know: the panes, which blank their other keys, and the
/// pane track, which must not take the same finger for a swipe.
///
/// Its own small object for the reason `ShiftModel` is: everything that
/// observes the bridge redraws on every keystroke and microphone reading, and
/// the panes exist not to. This publishes twice per trackpad drag — on and
/// off — and only the typing panes observe it.
final class SpaceCursorModel: ObservableObject {
    /// The other keys should recede. Published on a change only.
    @Published private(set) var steering = false

    /// The pane track must leave the current touch alone.
    ///
    /// Not published: the track reads it from its gesture callbacks, never
    /// from a body, so a change has nothing to redraw. And it outlives
    /// `steering` by one turn of the main queue, because the bar's `onEnded`
    /// and the track's run for the same lift in an order SwiftUI does not
    /// promise — cleared at once, it would let the track read the end of a
    /// long trackpad drag as a swipe to the next pane.
    private(set) var holdsTouch = false

    func begin() {
        holdsTouch = true
        if !steering { steering = true }
    }

    func end() {
        if steering { steering = false }
        guard holdsTouch else { return }
        DispatchQueue.main.async { [weak self] in self?.holdsTouch = false }
    }
}

extension EnvironmentValues {
    /// Every key but the space bar fades and drops its label: the space bar is
    /// a trackpad (`SpaceKey`), and a keyboard whose letters stay legible
    /// under a moving finger reads as one that will type them.
    ///
    /// An environment value rather than a parameter on every key, so the panes'
    /// key-building code is untouched and a key's `Equatable` is still about
    /// what it draws at rest. Each key reads it, so entering and leaving
    /// redraws each key once — twice per drag, never per keystroke.
    @Entry var keysRecede = false
}

extension View {
    /// A key's cap while `keysRecede` is on: faded far enough that the space
    /// bar is plainly the only key left, not so far that the keyboard looks
    /// as if it went away.
    func recedingCap(_ recede: Bool) -> some View {
        opacity(recede ? 0.45 : 1)
    }

    /// A key's label while `keysRecede` is on: gone, as on the system
    /// keyboard's trackpad.
    func recedingLabel(_ recede: Bool) -> some View {
        opacity(recede ? 0 : 1)
    }
}
