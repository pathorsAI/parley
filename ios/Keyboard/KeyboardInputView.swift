import UIKit

/// The keyboard's root view: the system's own `UIInputView`, plus two things
/// the stock one cannot do.
///
/// **It lets the keys click.** `UIDevice.playInputClick()` only makes a sound
/// when the input view on screen adopts `UIInputViewAudioFeedback` and says
/// clicks are enabled; the stock view does not, so every key on this keyboard
/// was silent even for people who have Keyboard Clicks switched on. The
/// user's setting still decides — this only stops the keyboard from vetoing it.
/// See `KeyClick`.
///
/// **It says when it lands in a window**, so the controller can switch off the
/// system's edge-gesture delay there (`KeyboardViewController.stopDelayingTouches`).
/// A view controller hears `viewDidAppear`, but not a move to a different
/// window while it stays on screen; the view hears both.
///
/// It is created in `loadView` with the same style the stock view has, so the
/// system paints the same backdrop behind it and self-sizing and the height
/// constraint work exactly as before.
final class KeyboardInputView: UIInputView, UIInputViewAudioFeedback {
    var enableInputClicksWhenVisible: Bool { true }

    /// Called whenever the view moves into a window.
    var didMoveToNewWindow: (() -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { didMoveToNewWindow?() }
    }
}
