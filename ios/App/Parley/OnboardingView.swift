import ParleyKit
import SwiftUI

/// The onboarding's four steps, the phone's take on the desktop wizard's Cloud
/// route (`src/lib/onboarding/steps.ts`): say what Parley is, sign in, settle
/// the organization, then hand off to a first run.
///
/// The desktop also has a Local route (own keys or an on-device model), a model
/// step, a microphone check and a context step. The phone has none of them:
/// recording on the phone always streams through the account's hosted relay,
/// so there is no route to choose and no model to pick, and the microphone
/// prompt deliberately waits for the first recording (see
/// `docs/design/onboarding.md`).
///
/// The first two steps are `OnboardingView`, in front of the sign-in gate; the
/// last two are `OnboardingAfterSignIn`, over the tabs, because by then the
/// account exists and the gate has already swapped the app in.
enum OnboardingStep: Int, CaseIterable {
    case intro, account, org, done
}

/// Set when sign-in starts from the onboarding, cleared when its last step is
/// left. Signed-in users from before this flow never see the post-sign-in
/// steps; someone who signs in for the first time sees them once.
enum OnboardingFlag {
    static let afterSignInKey = "onboarding.afterSignIn"
    static let completedKey = "onboarding.completed"
}

/// First run. Recording on the phone streams through the account's hosted
/// transcription relay and syncs to that account, so there is nothing useful to
/// do before signing in — the previous build let people through to a Recording
/// tab whose button was permanently disabled, which is what App Review found
/// (submission 9ebcfa58, guideline 2.1(a)).
///
/// So the account comes first, and these two screens have to earn it: say what
/// the app does, then what signing in buys and what it costs, before asking.
/// Per `docs/design/pricing.md` P3/P4 there is no anonymous trial — the free
/// tier is the trial, and these screens are the whole distance between opening
/// the app and being able to record.
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState
    @State private var step: OnboardingStep = .intro
    @AppStorage(OnboardingFlag.afterSignInKey) private var afterSignIn = false
    @AppStorage(OnboardingFlag.completedKey) private var completed = false

    var body: some View {
        Group {
            switch step {
            case .account:
                accountStep.transition(.opacity)
            default:
                introStep.transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: step)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        #if DEBUG
            .onReceive(ScreenshotDemo.shared.$onboarding) { scenario in
                if scenario == .account { step = .account }
            }
        #endif
    }

    // MARK: 1 · intro

    private var introStep: some View {
        VStack(spacing: 0) {
            // The pitch scrolls; the button does not. At the largest Dynamic
            // Type sizes this content is taller than an iPhone, and the one
            // control that matters must never be the part pushed off screen.
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 24)
                    header
                    Spacer(minLength: 28)
                    IntroStage()
                        .frame(maxWidth: 420)
                    Spacer(minLength: 24)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
            }
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 14) {
                OnboardingDots(current: .intro)
                OnboardingPrimaryButton(title: "Get started") { step = .account }
                Text("Setup takes a minute.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 28)
            .padding(.top, 8)
            .padding(.bottom, 20)
        }
    }

    /// The first thing anyone sees of the product, so it is the wordmark rather
    /// than a heading that happens to say "Parley": Alexandria, at 40pt, in ink.
    private var header: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityHidden(true)
            Text(verbatim: "Parley")
                .font(.parley.wordmark(size: 40))
                .foregroundStyle(Color(.label))
            Text("Welcome to Parley!")
                .font(.parley.title3)
                .foregroundStyle(Color(.label))
                .multilineTextAlignment(.center)
            Text("Record it. Hand it to the AI you already use.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: 2 · account

    /// The desktop's account step is a choice between Cloud and Local. The
    /// phone only has Cloud, so it shows that card alone and says where Local
    /// lives, rather than offering a choice it cannot honour.
    private var accountStep: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Sign in to Parley")
                        .font(.parley.title2)
                        .foregroundStyle(Color(.label))
                        .padding(.top, 32)
                    cloudCard
                    Text("Local — your own API keys or a model on your computer — is available in the desktop app.")
                        .font(.parley.footnote)
                        .foregroundStyle(Color(.secondaryLabel))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: 420, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
            }
            .scrollBounceBehavior(.basedOnSize)

            signInActions
                .frame(maxWidth: 420)
                .padding(.horizontal, 28)
                .padding(.top, 8)
                .padding(.bottom, 20)
        }
    }

    private var cloudCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Cloud")
                .font(.parley.caption)
                .foregroundStyle(Theme.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Theme.primary.opacity(0.12), in: Capsule())
            Text("Sign in and use Parley's transcription and AI models, free within a monthly allowance, no keys needed. Claude on the web or your phone can read your recordings through the MCP connector.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Theme.radius))
    }

    private var signInActions: some View {
        VStack(spacing: 12) {
            OnboardingDots(current: .account)

            OnboardingPrimaryButton(
                title: app.signingIn ? "Signing in…" : "Sign in or create an account",
                busy: app.signingIn
            ) {
                // Only someone who has never finished the onboarding goes on
                // to the organization and hand-off steps after signing in.
                if !completed { afterSignIn = true }
                app.signIn()
            }

            if let error = app.signInError {
                Text(error)
                    .font(.parley.footnote)
                    .foregroundStyle(Theme.destructive)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("Email and password, Google, and Apple all work.")
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("Back") { step = .intro }
                    .font(.parley.subheadline)
                    .disabled(app.signingIn)
                Spacer()
                Link("Privacy Policy", destination: URL(string: "https://parley.tw/privacy/")!)
                    .font(.parley.caption)
            }
        }
    }
}

// MARK: - shared pieces

/// Where the user is in the four steps. Read out as "Step n of 4".
struct OnboardingDots: View {
    let current: OnboardingStep

    var body: some View {
        let total = OnboardingStep.allCases.count
        let index = current.rawValue + 1
        HStack(spacing: 6) {
            ForEach(OnboardingStep.allCases, id: \.rawValue) { step in
                Capsule()
                    .fill(step == current ? Theme.primary : Color(.tertiaryLabel))
                    .frame(width: step == current ? 18 : 6, height: 6)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Step \(index) of \(total)"))
    }
}

/// The one filled blue surface on each onboarding screen.
///
/// Blue is a signal, and a fill behind content is out — but this is not
/// behind content, it *is* the content: the single action on a screen that
/// has one. Flat `primary`, not a gradient.
struct OnboardingPrimaryButton: View {
    let title: LocalizedStringKey
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(.white) }
                Text(title)
                    .font(.parley.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            // Fixed white, not a semantic colour: the fill under it is the
            // signal blue in both appearances, so its label must not invert
            // with the system's.
            .foregroundStyle(.white)
            .background(Theme.primary, in: RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

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
