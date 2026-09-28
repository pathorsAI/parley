import SwiftUI
import UIKit

// MARK: - Tuning

/// Every number that shapes the sign-in page's edge glow, in one place, so the
/// look can be carried unchanged to Android (AGSL) and the desktop (WebGL).
///
/// The fields, per point round the edge. `u` is the position round the
/// perimeter in [0, 1), clockwise from the top-left; `t` is the flow clock in
/// seconds, which runs at `speed` (so the clock is integrated, never `now ×
/// speed`, or a change of speed would jump the pattern):
///
///     i     = 0.55 + 0.30·sin 2π(2u + 0.07t) + 0.20·sin 2π(5u − 0.11t)
///     c     = 0.5 + 0.5·sin 2π(1.5u − 0.05t)          blue → sky
///     w     = 0.5 + 0.5·sin 2π(4u + 0.09t)
///     glint = max(0, w − 0.55)·1.4·i                   towards white
///
/// Those coefficients are the approved prototype's and live in the shader
/// (`AuroraEdgeGlow.metal`) as literals; they are the design, not knobs. The
/// one change made in porting: `c` goes round the loop one and a half times,
/// so its two ends disagree where `u` wraps, and the last `colourSeam` of the
/// loop is blended into the start; left alone it would show as a colour step
/// at the top-left corner.
///
/// Three layers are drawn from those fields, each a band that starts at the
/// edge and is blurred by a Gaussian (see the shader for why that is a closed
/// form rather than a blur pass):
///
/// - **haze**: `hazeReach + hazeReachPerI·i` points deep, `hazeBlur` soft,
///   opacity `hazeStrength·i`. The wide glow; where the field is strong it
///   reaches further into the page.
/// - **core**: `coreWidth` (lerped by i) deep, `coreBlur` soft, opacity
///   `coreStrength·(0.35 + 0.65·i)`. The bright thread along the glass.
/// - **glass**: a `glassWidth` white hairline `glassInset` inside the edge at
///   `glassStrength`, steady whatever the field does.
///
/// All opacities scale with `level` (1 idle, `signingInLevel` while signing
/// in, 0 gone), and the haze reach with `(1 + level) / 2`, so signing in
/// reaches a little further as well as shining brighter, and the success fade
/// draws the light back into the edge as it dims.
///
/// Dark mode adds the light to the page (`plusLighter`), so it reads as light
/// rather than paint. Light mode lays it over the page normally, a touch more
/// saturated (`lightSaturation`), and keeps the white glints mostly in the core
/// (`lightHazeWhite`), because white haze on a white page is no haze at all.
enum AuroraEdgeGlowTuning {
    // Colour: the brand blue and the sky blue (ParleyDesignTokens' two
    // `primary` values), as sRGB 0–1.
    static let blue = SIMD3<Float>(0x14, 0x69, 0xD4) / 255
    static let sky = SIMD3<Float>(0x2D, 0xB6, 0xF3) / 255
    static let colourSeam: Float = 0.08

    // Haze.
    static let hazeReach: Float = 8
    static let hazeReachPerI: Float = 16
    static let hazeBlur: Float = 14
    static let hazeStrengthDark: Float = 0.62
    static let hazeStrengthLight: Float = 0.36

    // Core.
    static let coreWidthMin: Float = 2
    static let coreWidthMax: Float = 7
    static let coreBlur: Float = 2
    static let coreStrengthDark: Float = 0.95
    static let coreStrengthLight: Float = 0.85

    // Glass.
    static let glassInset: Float = 1.2
    static let glassWidth: Float = 0.8
    static let glassStrengthDark: Float = 0.30
    static let glassStrengthLight: Float = 0.55

    // Light mode.
    static let lightSaturation: Float = 1.18
    static let lightHazeWhite: Float = 0.15
    static let darkHazeWhite: Float = 0.7

    // States. Level multiplies every opacity; speed multiplies the clock.
    static let idleLevel: Double = 1
    static let idleSpeed: Double = 1
    static let signingInLevel: Double = 1.45
    static let signingInSpeed: Double = 2.6
    /// Idle ⇄ signing in, both ways.
    static let stateEase: TimeInterval = 0.6
    /// From nothing to idle, when the sign-in page first appears.
    static let appearFade: TimeInterval = 0.7
    /// From wherever it is to nothing, once the account is in.
    static let successFade: TimeInterval = 0.85

    /// Reduce Motion: no flow, and signing in is a step up in brightness
    /// rather than a ramp and a faster current.
    static let reducedSigningInLevel: Double = 1.2

    /// The screen's corner radius before iOS 26, which has no public way to
    /// ask for it: a fixed continuous radius on any phone with a home
    /// indicator, square on the ones with a home button. See
    /// `DisplayCornerReader`.
    static let fallbackCornerRadius: CGFloat = 55

    /// 60 frames a second is plenty for a current this slow, and half what a
    /// ProMotion screen would otherwise ask of a full-screen shader.
    static let frameInterval: TimeInterval = 1 / 60
}

// MARK: - The overlay

/// A slow aurora of blue-and-white light breathing round the edge of the
/// screen while the sign-in page is up — the one screen in the app where
/// nothing is happening yet, and the one that has to make someone want in.
///
/// It is also the sign-in's progress signal. The button already turns into a
/// spinner, but the button is under the auth sheet for most of a sign-in, and
/// the edge of the screen is not: while `AppState.signingIn` the glow brightens
/// and quickens (`signingInLevel`, `signingInSpeed`), and when the account is
/// in it fades away as the app appears — so the moment reads as the page
/// letting you through rather than being swapped out. A failed or cancelled
/// sign-in eases back to idle.
///
/// That fade is why this is hosted by `RootView` and not by `OnboardingView`.
/// On success the root switches to `MainTabs` in the same transaction that
/// stores the token, so the onboarding view is gone in that frame; a glow that
/// lived inside it would vanish with it rather than fade. Up here it outlives
/// the page by exactly the fade, then removes itself, and nothing on the rest
/// of the app pays for it.
///
/// It is an overlay rather than a background because every screen under it
/// paints an opaque page, and it stays out of the way of that page on purpose:
/// it lives in the outer ~30pt the page's own margins leave empty, it never
/// takes a touch, and VoiceOver never hears of it.
///
/// Drawn by one colour-effect shader over the whole screen
/// (`AuroraEdgeGlow.metal`). The per-frame clock stops whenever the glow is
/// not flowing: under Reduce Motion, in the background, and once it has faded
/// out, when the view is removed entirely.
struct AuroraEdgeGlow: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    /// Whether the glow is in the hierarchy at all. True while the sign-in
    /// page is up and for the length of the success fade after it.
    @State private var mounted = false
    /// Reduce Motion's stand-in for the level ramp: the fade is SwiftUI's.
    @State private var reducedOpacity: Double = 0
    @State private var clock = AuroraClock()
    @State private var cornerRadius: CGFloat = 0
    @State private var unmountTask: Task<Void, Never>?

    private var onSignInPage: Bool { app.bootstrapped && !app.hasAccount }

    var body: some View {
        ZStack {
            if mounted {
                glow
            }
        }
        // Full size even when empty, so the corner probe behind it sits flush
        // with the screen's edges from the first frame.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            DisplayCornerReader { cornerRadius = $0 }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { update(animated: false) }
        .onChange(of: onSignInPage) { update(animated: true) }
        .onChange(of: app.signingIn) { update(animated: true) }
        .onChange(of: reduceMotion) { update(animated: false) }
    }

    private var glow: some View {
        TimelineView(
            .animation(
                minimumInterval: AuroraEdgeGlowTuning.frameInterval,
                paused: reduceMotion || scenePhase == .background)
        ) { context in
            let frame = reduceMotion ? reducedFrame : clock.advance(to: context.date)
            GeometryReader { proxy in
                Rectangle()
                    .fill(.black)
                    .colorEffect(shader(frame: frame, size: proxy.size))
            }
            .blendMode(colorScheme == .dark ? .plusLighter : .normal)
            .opacity(reduceMotion ? reducedOpacity : 1)
        }
        #if DEBUG
            .overlay {
                // `-ParleyAuroraShowShape YES`: SwiftUI's own idea of the
                // screen's corners, in red, to hold the glow against.
                if #available(iOS 26.0, *), UserDefaults.standard.bool(forKey: "ParleyAuroraShowShape") {
                    ConcentricRectangle().stroke(.red, lineWidth: 1)
                }
            }
        #endif
    }

    private var reducedFrame: AuroraClock.Frame {
        AuroraClock.Frame(
            t: 0,
            level: app.signingIn
                ? AuroraEdgeGlowTuning.reducedSigningInLevel : AuroraEdgeGlowTuning.idleLevel)
    }

    private func shader(frame: AuroraClock.Frame, size: CGSize) -> Shader {
        typealias T = AuroraEdgeGlowTuning
        let dark = colorScheme == .dark
        return ShaderLibrary.auroraEdgeGlow(
            .float2(size),
            .float(Float(cornerRadius)),
            .float(Float(frame.t)),
            .float(Float(frame.level)),
            .float4(Float(dark ? 1 : 0), Float(reduceMotion ? 0 : 1), Float(1 / max(displayScale, 1)), Float(0)),
            .float4(T.hazeReach, T.hazeReachPerI, T.hazeBlur, dark ? T.hazeStrengthDark : T.hazeStrengthLight),
            .float4(T.coreWidthMin, T.coreWidthMax, T.coreBlur, dark ? T.coreStrengthDark : T.coreStrengthLight),
            .float4(T.glassInset, T.glassWidth, dark ? T.glassStrengthDark : T.glassStrengthLight, Float(0)),
            .float4(T.lightSaturation, T.lightHazeWhite, T.darkHazeWhite, T.colourSeam),
            .float3(T.blue.x, T.blue.y, T.blue.z),
            .float3(T.sky.x, T.sky.y, T.sky.z))
    }

    /// Point the glow at whatever the app is doing now.
    ///
    /// Four moves: the page appears (fade in to idle), a sign-in starts or
    /// stops (ease between idle and signing in), and the account arrives (fade
    /// to nothing, then unmount). Under Reduce Motion the level is read
    /// straight from `signingIn` each render and only the appear and success
    /// fades animate, as plain opacity.
    private func update(animated: Bool) {
        typealias T = AuroraEdgeGlowTuning
        let now = Date()
        let signingIn = app.signingIn

        if onSignInPage {
            unmountTask?.cancel()
            unmountTask = nil
            let appearing = !mounted
            mounted = true
            let level = signingIn ? T.signingInLevel : T.idleLevel
            let speed = signingIn ? T.signingInSpeed : T.idleSpeed
            let duration = appearing ? T.appearFade : T.stateEase
            clock.ramp(level: level, speed: speed, over: animated || appearing ? duration : 0, at: now)
            if appearing {
                withAnimation(.easeOut(duration: T.appearFade)) { reducedOpacity = 1 }
            }
        } else if mounted {
            clock.ramp(level: 0, speed: nil, over: animated ? T.successFade : 0, at: now)
            withAnimation(.easeOut(duration: animated ? T.successFade : 0)) { reducedOpacity = 0 }
            unmountTask?.cancel()
            unmountTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(animated ? T.successFade + 0.1 : 0))
                guard !Task.isCancelled, !onSignInPage else { return }
                mounted = false
            }
        }
    }
}

// MARK: - The clock

/// The glow's time and brightness, advanced once per frame.
///
/// A class held in `@State` rather than state of its own, because it changes on
/// every frame and nothing should re-render because of that except the
/// `TimelineView` that asked. Two things it has to get right:
///
/// - `t` is *integrated*: each frame adds its duration times the current
///   speed. Multiplying the wall clock by speed instead would make the pattern
///   leap the moment signing in doubles the speed.
/// - a frame after a pause (the background, a hitch) adds at most
///   `maxStep`, so coming back to the app resumes the flow where it was rather
///   than skipping it forward.
@MainActor
final class AuroraClock {
    struct Frame {
        var t: Double
        var level: Double
    }

    private struct Ramp {
        var from: Double
        var to: Double
        var start: Date
        var duration: TimeInterval

        func value(at date: Date) -> Double {
            guard duration > 0 else { return to }
            let x = min(max(date.timeIntervalSince(start) / duration, 0), 1)
            // Ease in and out: a smoothstep, so the change has no corner at
            // either end.
            let eased = x * x * (3 - 2 * x)
            return from + (to - from) * eased
        }
    }

    private static let maxStep: TimeInterval = 1 / 15

    private var t: Double = 0
    private var last: Date?
    private var level = Ramp(from: 0, to: 0, start: .distantPast, duration: 0)
    private var speed = Ramp(from: 1, to: 1, start: .distantPast, duration: 0)

    /// Head for `level` (and `speed`, if given) from wherever the glow is right
    /// now, over `duration`.
    func ramp(level newLevel: Double, speed newSpeed: Double?, over duration: TimeInterval, at now: Date) {
        level = Ramp(from: level.value(at: now), to: newLevel, start: now, duration: duration)
        if let newSpeed {
            speed = Ramp(from: speed.value(at: now), to: newSpeed, start: now, duration: duration)
        }
    }

    func advance(to now: Date) -> Frame {
        if let last {
            let step = min(max(now.timeIntervalSince(last), 0), Self.maxStep)
            t += step * speed.value(at: now)
        }
        last = now
        return Frame(t: t, level: level.value(at: now))
    }
}

// MARK: - The screen's corners

/// Reports the corner radius of the physical display, so the glow can follow
/// its curve.
///
/// iOS 26 answers this publicly: a view whose corners are
/// `.containerConcentric()` and that sits flush with the window resolves to
/// exactly the display's radius, and `effectiveRadius(corner:)` says what that
/// came to. It is the UIKit face of the same system SwiftUI's
/// `ConcentricRectangle` draws with, and the one of the two that hands back a
/// number, which a shader needs.
///
/// Before iOS 26 there is no public answer. The display radius is known to
/// UIKit as the private `_displayCornerRadius`, which is exactly the kind of
/// call App Review rejects builds for, so it is not read. The fallback instead
/// assumes `AuroraEdgeGlowTuning.fallbackCornerRadius` on any phone with a
/// home indicator (a bottom safe-area inset) and square corners on the ones
/// with a home button. Where the real curve is tighter than that, the shader
/// lights the sliver outside its arc as edge rather than leaving it dark.
///
/// `-ParleyAuroraFallbackCorners YES` (DEBUG) takes the fallback on iOS 26 too,
/// so it can be seen without an older simulator.
private struct DisplayCornerReader: UIViewRepresentable {
    let onChange: (CGFloat) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.onChange = onChange
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.onChange = onChange
    }

    final class ProbeView: UIView {
        var onChange: ((CGFloat) -> Void)?
        private var reported: CGFloat?

        override init(frame: CGRect) {
            super.init(frame: frame)
            if #available(iOS 26.0, *) {
                cornerConfiguration = .corners(radius: .containerConcentric())
            }
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            report()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            report()
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            report()
        }

        private func report() {
            guard let window else { return }
            var radius: CGFloat = 0
            if #available(iOS 26.0, *), !Self.forceFallback {
                radius = effectiveRadius(corner: .topLeft)
            }
            if radius <= 0 {
                radius = window.safeAreaInsets.bottom > 0 ? AuroraEdgeGlowTuning.fallbackCornerRadius : 0
            }
            guard radius != reported else { return }
            reported = radius
            // Out of the layout pass before it becomes SwiftUI state.
            DispatchQueue.main.async { [onChange] in onChange?(radius) }
        }

        private static var forceFallback: Bool {
            #if DEBUG
                UserDefaults.standard.bool(forKey: "ParleyAuroraFallbackCorners")
            #else
                false
            #endif
        }
    }
}
