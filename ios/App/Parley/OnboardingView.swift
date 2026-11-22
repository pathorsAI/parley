import ParleyKit
import SwiftUI

/// The onboarding, a port of the desktop wizard's Cloud route
/// (`src/components/Onboarding.tsx`, `src/lib/onboarding/steps.ts`): say what
/// Parley is, sign in, settle the organization, allow the microphone, check
/// it, tell the AI who the user is, then hand off to a first run.
///
/// The desktop's Local route (own keys or an on-device model) and its model
/// step have no phone counterpart — recording on the phone always streams
/// through the account's hosted relay — so the account step shows the Local
/// card only to say where it lives.
///
/// The steps before sign-in are `OnboardingView`, in front of the sign-in gate
/// (`RootView`); the rest are the same `OnboardingFlow` over the tabs
/// (`MainTabs`), because once the account exists the gate has already swapped
/// the app in.
enum OnboardingStep: String, CaseIterable {
    case intro, account, org, perms, mic, context, done

    var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// The header title, as the desktop's `stepTitle`. The welcome and done
    /// screens have none: they are the hero screens.
    var title: LocalizedStringKey {
        switch self {
        case .intro, .done: return ""
        case .account: return "Choose how to run Parley"
        case .org: return "Organization"
        case .perms: return "iOS permissions"
        case .mic: return "Microphone check"
        case .context: return "Context"
        }
    }

    var isHero: Bool { self == .intro || self == .done }

    var next: OnboardingStep {
        let all = Self.allCases
        return all[min(all.count - 1, index + 1)]
    }

    var previous: OnboardingStep {
        let all = Self.allCases
        return all[max(0, index - 1)]
    }
}

/// UserDefaults keys the onboarding keeps between launches.
enum OnboardingFlag {
    /// Set when sign-in starts from the onboarding, cleared when the wizard is
    /// left. Signed-in users from before this flow never see the rest of it.
    static let afterSignInKey = "onboarding.afterSignIn"
    /// The wizard has been finished or skipped once on this device.
    static let completedKey = "onboarding.completed"
    /// The step to resume on, so leaving for Settings to allow the microphone
    /// does not bounce the user back to the start.
    static let stepKey = "onboarding.step"
    /// The speaker background (the desktop's `settings.userBackground`),
    /// seeded by the microphone check and edited on the context step.
    static let backgroundKey = "onboarding.userBackground"
}

/// How the user left the wizard.
enum OnboardingExit {
    case skip, sample, record
}

/// Signed out: the first two steps, in front of the sign-in gate.
struct OnboardingView: View {
    @AppStorage(OnboardingFlag.stepKey) private var savedStep = ""

    var body: some View {
        OnboardingFlow(start: OnboardingStep(rawValue: savedStep) == .account ? .account : .intro) { _ in }
    }
}

// MARK: - the wizard

struct OnboardingFlow: View {
    @EnvironmentObject private var app: AppState
    @AppStorage(OnboardingFlag.stepKey) private var savedStep = ""
    @State private var step: OnboardingStep
    private let finish: (OnboardingExit) -> Void

    init(start: OnboardingStep, finish: @escaping (OnboardingExit) -> Void) {
        _step = State(initialValue: start)
        self.finish = finish
    }

    var body: some View {
        VStack(spacing: 0) {
            if step.isHero {
                heroTopBar
            } else {
                OnboardingHeader(step: step)
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .id(step)
                .transition(.opacity)
            if let footer = footerKind {
                OnboardingFooter(
                    kind: footer,
                    skipEnabled: app.hasAccount,
                    onSkip: { finish(.skip) },
                    onBack: { go(step.previous) },
                    onNext: { go(step.next) })
            }
        }
        .animation(.easeInOut(duration: 0.25), value: step)
        .background(alignment: .top) {
            if step.isHero {
                ZStack(alignment: .top) {
                    OnboardingPalette.heroBackground
                    OnboardingHeroBars()
                }
                .ignoresSafeArea()
            } else {
                Theme.background.ignoresSafeArea()
            }
        }
        .onChange(of: step) { _, now in savedStep = now.rawValue }
        #if DEBUG
            .onReceive(ScreenshotDemo.shared.$onboarding) { scenario in
                if let start = scenario?.step { step = start }
            }
        #endif
    }

    private func go(_ target: OnboardingStep) { step = target }

    /// Which footer this step gets, as the desktop's `footerFor`: none while
    /// the account step offers its two cards or the organization step its
    /// choices (each card has its own button), none on the last screen; Skip
    /// and Get started on the welcome and the signed-in confirmation.
    private var footerKind: OnboardingFooter.Kind? {
        switch step {
        case .intro: return .skipStart
        case .account: return app.hasAccount ? .skipStart : nil
        case .org: return orgChoosing ? nil : .backNext
        case .done: return nil
        default: return .backNext
        }
    }

    @StateObject private var org = OnboardingOrgModel()
    /// Owned by the wizard, not the step: leaving the step mid-sentence still
    /// finishes saving it, and testing again later still knows what the
    /// previous run put in, so it can take it back out.
    @StateObject private var micCheck = MicCheckModel()
    private var orgChoosing: Bool {
        switch org.phase {
        case .choosing, .loading: return true
        case .joined, .failed: return false
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .intro:
            OnboardingIntroStep()
        case .account:
            OnboardingAccountStep(onBack: { go(.intro) })
        case .org:
            OnboardingOrgStep(model: org, onBack: { go(.account) }, onContinue: { go(.perms) })
        case .perms:
            OnboardingPermsStep()
        case .mic:
            OnboardingMicStep(check: micCheck)
        case .context:
            OnboardingContextStep()
        case .done:
            OnboardingDoneStep(finish: finish)
        }
    }

    /// The hero screens have no title bar: only the language in the corner.
    private var heroTopBar: some View {
        HStack {
            Spacer()
            OnboardingLanguageButton(onHero: true)
        }
        .frame(height: 60)
        .padding(.horizontal, 20)
    }
}

// MARK: - chrome

/// The colours the desktop wizard draws with that the app's `Theme` does not
/// have. Light values are the desktop's own; dark ones follow its dark-mode
/// classes (`dark:from-primary/15`, `dark:bg-muted`…).
enum OnboardingPalette {
    static let heroBackground = adaptive(light: 0xF5F5F5, dark: 0x1C1C1E)
    static let ink = Color(.label)
    static let inkSoft = Color(.label).opacity(0.7)
    static let hairline = adaptive(light: 0xE3E6EC, dark: 0x38383A)
    static let segment = adaptive(light: 0xE6E6E6, dark: 0x38383A)
    static let blueCardTop = adaptive(light: 0xE1F2FD, dark: 0x13263D)
    static let blueCardBottom = adaptive(light: 0xFFFFFF, dark: 0x0F1115)
    static let greyCardTop = adaptive(light: 0xF5F5F5, dark: 0x1F2024)
    static let greyCardBottom = adaptive(light: 0xFAFAFA, dark: 0x18191C)
    static let pill = adaptive(light: 0xFFFFFF, dark: 0x2A2B30, lightAlpha: 0.7)
    static let greenPill = adaptive(light: 0xD9F7E5, dark: 0x163D28)
    static let greenInk = adaptive(light: 0x006A3B, dark: 0x6FDBA0)
    static let bubble = adaptive(light: 0xF5F5F5, dark: 0x2A2B30)

    static func adaptive(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1) -> Color {
        Color(
            UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(hex: dark)
                    : UIColor(hex: light).withAlphaComponent(lightAlpha)
            })
    }
}

/// The blue bars behind the welcome and done screens — the desktop's
/// `IntroHero`, bar for bar: thirteen columns, deepest at the edges, each a
/// vertical fade from the page into its blue and back.
struct OnboardingHeroBars: View {
    private struct Bar {
        let inset: CGFloat
        let color: UInt32
        var alpha: Double = 1
    }

    private let bars: [Bar] = [
        Bar(inset: 0, color: 0x1469D4),
        Bar(inset: 11.01, color: 0x1979DA),
        Bar(inset: 19.07, color: 0x1D86E0),
        Bar(inset: 26.82, color: 0x2191E4),
        Bar(inset: 31.16, color: 0x2191E4, alpha: 0.9),
        Bar(inset: 38.45, color: 0x2AACEF, alpha: 0.8),
        Bar(inset: 42.48, color: 0x2DB6F3, alpha: 0.7),
        Bar(inset: 38.45, color: 0x2AACEF, alpha: 0.8),
        Bar(inset: 31.16, color: 0x259DE9, alpha: 0.9),
        Bar(inset: 26.82, color: 0x2191E4),
        Bar(inset: 19.07, color: 0x1D86E0),
        Bar(inset: 11.01, color: 0x1979DA),
        Bar(inset: 0, color: 0x1469D4),
    ]

    /// The desktop draws the bars 398 pt tall and lifts them 198 pt above the
    /// dialog, so only their lower half shows. A phone screen is far taller
    /// than the desktop dialog, so here they run 460 pt and show about 300 pt
    /// under the status bar, reaching down past the step row.
    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width / CGFloat(bars.count)
            let height: CGFloat = 460
            ZStack(alignment: .topLeading) {
                ForEach(bars.indices, id: \.self) { i in
                    let bar = bars[i]
                    let blue = Color(UIColor(hex: bar.color)).opacity(bar.alpha)
                    let edge = OnboardingPalette.heroBackground.opacity(bar.alpha)
                    LinearGradient(colors: [edge, blue, edge], startPoint: .top, endPoint: .bottom)
                        .frame(width: width + 0.5, height: height * (1 - 2 * bar.inset / 100))
                        .offset(x: CGFloat(i) * width, y: height * bar.inset / 100)
                }
            }
            .frame(width: geo.size.width, height: height, alignment: .topLeading)
            .offset(y: -160)
            .opacity(0.8)
        }
        .frame(height: 310)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Every step after the welcome: its title, the language, and a progress bar
/// along the bottom edge — one segment per step after the welcome.
struct OnboardingHeader: View {
    let step: OnboardingStep

    var body: some View {
        HStack {
            Text(step.title)
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Theme.primary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            OnboardingLanguageButton(onHero: false)
        }
        .frame(height: 60)
        .padding(.horizontal, 20)
        .overlay(alignment: .bottom) {
            OnboardingProgress(reached: step.index, total: OnboardingStep.allCases.count - 1)
        }
    }
}

struct OnboardingProgress: View {
    let reached: Int
    let total: Int

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<total, id: \.self) { i in
                Rectangle()
                    .fill(i < reached ? Theme.primary : OnboardingPalette.segment)
                    .frame(height: 1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Step \(reached) of \(total)"))
    }
}

/// The desktop's language menu. iOS keeps an app's language in the system's
/// per-app settings, so this shows the current one and opens that page.
struct OnboardingLanguageButton: View {
    let onHero: Bool
    @Environment(\.openURL) private var openURL

    private var shortLabel: String {
        (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh") ? "繁中" : "EN"
    }

    var body: some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "globe")
                    .font(.system(size: 13))
                Text(verbatim: shortLabel)
                    .font(.parley.caption)
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .foregroundStyle(onHero ? Color.white : OnboardingPalette.ink)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Interface language"))
    }
}

/// The footer bar: a hairline above, the way back (or Skip) on the left and
/// the blue way on to the right.
struct OnboardingFooter: View {
    enum Kind { case backNext, skipStart }

    let kind: Kind
    let skipEnabled: Bool
    let onSkip: () -> Void
    let onBack: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            switch kind {
            case .skipStart:
                OnboardingGhostButton(title: "Skip", action: onSkip)
                    .disabled(!skipEnabled)
                    .opacity(skipEnabled ? 1 : 0.4)
                Spacer()
                OnboardingBlueButton(title: "Get started", trailingIcon: "chevron.right", action: onNext)
            case .backNext:
                OnboardingGhostButton(title: "Back", leadingIcon: "chevron.left", action: onBack)
                Spacer()
                OnboardingBlueButton(title: "Next", trailingIcon: "chevron.right", action: onNext)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .overlay(alignment: .top) {
            Rectangle().fill(OnboardingPalette.hairline).frame(height: 1)
        }
    }
}

// MARK: - buttons and cards shared by the steps

/// The desktop's small filled button (`size="sm" h-8 text-xs`), a little taller
/// for a finger.
struct OnboardingBlueButton: View {
    let title: LocalizedStringKey
    var trailingIcon: String? = nil
    var busy = false
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small).tint(.white) }
                Text(title).font(.parley.subheadlineEmphasized)
                if let trailingIcon, !busy {
                    Image(systemName: trailingIcon).font(.system(size: 12, weight: .semibold))
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 38)
            .foregroundStyle(.white)
            .background(Theme.primary.opacity(isEnabled ? 1 : 0.5), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

/// The desktop's ghost button: text only, an optional chevron.
struct OnboardingGhostButton: View {
    let title: LocalizedStringKey
    var leadingIcon: String? = nil
    var trailingIcon: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let leadingIcon { Image(systemName: leadingIcon).font(.system(size: 12, weight: .semibold)) }
                Text(title).font(.parley.subheadline)
                if let trailingIcon { Image(systemName: trailingIcon).font(.system(size: 12, weight: .semibold)) }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 38)
            .foregroundStyle(OnboardingPalette.ink)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The desktop's white button on a grey card ("使用地端版 ›", "繼續 ›").
struct OnboardingWhiteButton: View {
    let title: LocalizedStringKey
    var trailingIcon: String? = "chevron.right"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).font(.parley.subheadline)
                if let trailingIcon { Image(systemName: trailingIcon).font(.system(size: 12, weight: .semibold)) }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .foregroundStyle(OnboardingPalette.ink)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

/// A soft pill naming a choice or a confirmed fact.
struct OnboardingPill: View {
    enum Style { case plain, blue, green }

    let icon: Image
    let label: Text
    var style: Style = .plain

    var body: some View {
        HStack(spacing: 8) {
            icon.font(.system(size: 13))
            label.font(.parley.subheadline)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .foregroundStyle(foreground)
        .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch style {
        case .plain: return OnboardingPalette.ink
        case .blue: return Theme.primary
        case .green: return OnboardingPalette.greenInk
        }
    }

    private var background: Color {
        style == .green ? OnboardingPalette.greenPill : OnboardingPalette.pill
    }
}

/// The desktop's line art (`public/onboarding/*.svg`, as vector PDFs in the
/// asset catalog), drawn at its own size from a fixed corner so a taller card
/// never stretches it.
struct OnboardingLineArt: View {
    let name: String
    let size: CGSize
    var offset: CGSize = .zero

    var body: some View {
        Image(name)
            .resizable()
            .frame(width: size.width, height: size.height)
            .offset(offset)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// One side of an either/or drawn as a card — the desktop's `ChoiceCard`: a
/// soft pill naming the choice (with an optional note beside it), whatever the
/// choice needs, and the card's own button bottom-right, over a fade and a
/// piece of line art. `primary` is the blue card, otherwise grey.
struct OnboardingChoiceCard<Content: View, Action: View>: View {
    let primary: Bool
    let pill: OnboardingPill
    var note: LocalizedStringKey? = nil
    let art: OnboardingLineArt
    @ViewBuilder let content: Content
    @ViewBuilder let action: Action

    var body: some View {
        VStack(alignment: .trailing, spacing: 24) {
            VStack(alignment: .leading, spacing: 20) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        pill
                        Spacer(minLength: 8)
                        noteText.multilineTextAlignment(.trailing)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        pill
                        noteText
                    }
                }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action
        }
        .padding(20)
        .background(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                LinearGradient(
                    colors: primary
                        ? [OnboardingPalette.blueCardTop, OnboardingPalette.blueCardBottom]
                        : [OnboardingPalette.greyCardTop, OnboardingPalette.greyCardBottom],
                    startPoint: .top, endPoint: .bottom)
                art
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private var noteText: some View {
        if let note {
            Text(note)
                .font(.parley.footnote)
                .foregroundStyle(OnboardingPalette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The "or" between two choice cards.
struct OnboardingOrDivider: View {
    var body: some View {
        HStack(spacing: 16) {
            Rectangle().fill(OnboardingPalette.segment).frame(height: 1)
            Text("or").font(.parley.caption).foregroundStyle(Color(.secondaryLabel))
            Rectangle().fill(OnboardingPalette.segment).frame(height: 1)
        }
        .accessibilityHidden(true)
    }
}

/// A step's "you're set" card — the desktop's `ConfirmCard`: green pills, a
/// blue title and a grey line, centred over the blue fade and its line art.
struct OnboardingConfirmCard: View {
    let pills: [OnboardingPill]
    let title: LocalizedStringKey
    let message: LocalizedStringKey

    var body: some View {
        VStack(spacing: 24) {
            HStack(spacing: 8) {
                ForEach(pills.indices, id: \.self) { pills[$0] }
            }
            VStack(spacing: 4) {
                Text(title)
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Theme.primary)
                Text(message)
                    .font(.parley.subheadline)
                    .foregroundStyle(OnboardingPalette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                LinearGradient(
                    colors: [OnboardingPalette.blueCardTop, OnboardingPalette.blueCardBottom],
                    startPoint: .top, endPoint: .bottom)
                OnboardingLineArt(
                    name: "OnboardingConfirmLines", size: CGSize(width: 967, height: 415),
                    offset: CGSize(width: -444, height: 0))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - launch

/// Shown for the one moment between launch and the first `refreshSession()`
/// returning. Without it a returning user sees the sign-in wall flash by before
/// the stored session is confirmed.
struct LaunchView: View {
    var body: some View {
        VStack(spacing: 18) {
            Text(verbatim: "Parley")
                .font(.parley.wordmark(size: 32))
                .foregroundStyle(Color(.label))
                .accessibilityHidden(true)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .accessibilityLabel("Loading Parley")
    }
}
