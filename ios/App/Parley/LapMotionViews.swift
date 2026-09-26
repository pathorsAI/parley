import ParleyKit
import SwiftUI
import UIKit

/// The app half of `LapMotion` (ParleyKit): the spring as a SwiftUI
/// `Animation`, the two haptics the lap uses, and the three small pieces of
/// drawn motion — the confetti burst, the waveform ripple, the stage's
/// recording dot. Plain SwiftUI shapes, `Canvas` and `TimelineView`; no
/// animation library.
extension LapMotion {
    /// The one spring every lap entrance uses.
    static var spring: Animation {
        .spring(response: springResponse, dampingFraction: springDamping)
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Titles already typed in once this session, so the suggestion card's
    /// title types itself the first time it appears and simply is there after.
    @MainActor static var typedTitles: Set<String> = []

    /// Whether the finish of the lap on `recordingId` has had its burst. Kept,
    /// so going back and forth never re-fires it.
    static func hasCelebrated(_ recordingId: String) -> Bool {
        UserDefaults.standard.bool(forKey: "lapMotion.celebrated.\(recordingId)")
    }

    static func markCelebrated(_ recordingId: String) {
        UserDefaults.standard.set(true, forKey: "lapMotion.celebrated.\(recordingId)")
    }

    static func forgetCelebration(_ recordingId: String) {
        UserDefaults.standard.removeObject(forKey: "lapMotion.celebrated.\(recordingId)")
    }
}

/// One restrained burst: small accent-blue rectangles thrown up from the
/// bottom centre, falling back and fading over `LapMotion.confettiDuration`.
/// Deterministic — the pieces come from their index, not a random source — so
/// the same frame looks the same every time, and it draws nothing afterwards.
struct ConfettiBurst: View {
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60)) { context in
            let t = context.date.timeIntervalSince(start)
            Canvas { gc, size in
                guard t < LapMotion.confettiDuration else { return }
                let progress = t / LapMotion.confettiDuration
                let origin = CGPoint(x: size.width / 2, y: size.height)
                for i in 0..<LapMotion.confettiPieces {
                    let seed = Double(i)
                    // Three independent pseudo-random draws per piece, from
                    // its index: a fan of about 120° pointing up, a spread of
                    // speeds, a spread of start points along the bar.
                    let r1 = Self.unit(i, 1), r2 = Self.unit(i, 2), r3 = Self.unit(i, 3)
                    let angle = (-150 + 120 * r1) * .pi / 180
                    let speed = 180 + 240 * r2
                    let x = origin.x + (r3 - 0.5) * size.width * 0.5 + cos(angle) * speed * t
                    let y = origin.y + sin(angle) * speed * t + 420 * t * t
                    var piece = gc
                    piece.translateBy(x: x, y: y)
                    piece.rotate(by: .radians(t * (4 + seed.truncatingRemainder(dividingBy: 5))))
                    piece.opacity = max(0, 1 - progress * progress)
                    piece.fill(
                        Path(CGRect(x: -2, y: -3.5, width: 4, height: 7)),
                        with: .color(Theme.primary))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// A stable number in 0..<1 for piece `index`, draw `salt`.
    private static func unit(_ index: Int, _ salt: Int) -> Double {
        var x = UInt64(truncatingIfNeeded: index &* 2_654_435_761 &+ salt &* 40_503)
        x ^= x >> 33
        x = x &* 0xff51_afd7_ed55_8ccd
        x ^= x >> 33
        return Double(x % 10_000) / 10_000
    }
}

/// A ring that grows from a point and fades — where a tapped turn landed on
/// the waveform.
struct RippleRing: View {
    @State private var grown = false

    var body: some View {
        Circle()
            .stroke(Theme.primary, lineWidth: 1.5)
            .frame(width: 44, height: 44)
            .scaleEffect(grown ? 1 : 0.1)
            .opacity(grown ? 0 : 0.9)
            .onAppear {
                withAnimation(.easeOut(duration: LapMotion.ripple)) { grown = true }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
