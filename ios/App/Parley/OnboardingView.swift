import SwiftUI

/// First run. Recording on the phone streams through the account's hosted
/// transcription relay and syncs to that account, so there is nothing useful to
/// do before signing in — the previous build let people through to a Recording
/// tab whose button was permanently disabled, which is what App Review found
/// (submission 9ebcfa58, guideline 2.1(a)).
///
/// So the account comes first, and this screen has to earn it: say what the app
/// does, what signing in buys, and what it costs, before asking. Per
/// `docs/design/pricing.md` P3/P4 there is no anonymous trial — the free tier is
/// the trial, and this screen is the whole distance between opening the app and
/// being able to record.
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        VStack(spacing: 0) {
            // The pitch scrolls; the sign-in button does not. At the largest
            // Dynamic Type sizes this content is taller than an iPhone, and the
            // one control that matters must never be the part pushed off screen.
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 24)
                    header
                    Spacer(minLength: 28)
                    VStack(alignment: .leading, spacing: 22) {
                        ForEach(Self.points, id: \.icon) { point in
                            pointRow(point)
                        }
                    }
                    .frame(maxWidth: 420)
                    Spacer(minLength: 24)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
            }
            .scrollBounceBehavior(.basedOnSize)

            callToAction
                .padding(.horizontal, 28)
                .padding(.top, 8)
                .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }

    // MARK: header

    /// The first thing anyone sees of the product, so it is the wordmark rather
    /// than a heading that happens to say "Parley": Alexandria in the brand
    /// gradient, over a tinted disc carrying the glyph — the landing site's hero
    /// shape, at phone scale.
    private var header: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Theme.brand)
                .frame(width: 96, height: 96)
                .background(Theme.tintedSurface, in: Circle())
                .accessibilityHidden(true)
            Text(verbatim: "Parley")
                .font(.parley.wordmark(size: 40))
                .foregroundStyle(Theme.brandGradient)
            Text("A pocket recorder for the meetings you have in person — live transcript while you talk, in the cloud by the time you stand up.")
                .font(.parley.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: what you get

    private struct Point {
        let icon: String
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
    }

    private static let points: [Point] = [
        Point(
            icon: "record.circle",
            title: "Put the phone on the table",
            detail: "It picks up the whole room and keeps the speakers apart."),
        Point(
            icon: "text.bubble",
            title: "Live transcription, no API key",
            detail: "Sign in and ride our hosted transcription. The free tier covers everyday use."),
        Point(
            icon: "icloud",
            title: "Recordings sync to your account",
            detail: "Open a meeting you recorded on the phone in the desktop app for the deep analysis."),
    ]

    private func pointRow(_ point: Point) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: point.icon)
                .font(.parley.title3)
                .frame(width: 28)
                // `primary`, so the glyph stays legible on the navy-black page
                // in dark mode; `brand` is reserved for fills and the mark.
                .foregroundStyle(Theme.primary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(point.title)
                    .font(.parley.bodyEmphasized)
                    .foregroundStyle(Theme.foreground)
                Text(point.detail)
                    .font(.parley.footnote)
                    .foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: sign in

    private var callToAction: some View {
        VStack(spacing: 12) {
            Button {
                app.signIn()
            } label: {
                HStack(spacing: 8) {
                    if app.signingIn { ProgressView().tint(Theme.onBrand) }
                    Text(app.signingIn ? "Signing in…" : "Sign in or create an account")
                        .font(.parley.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                // Fixed white, like every other label on the gradient: the
                // gradient does not follow the system appearance, so neither
                // can the text sitting on it.
                .foregroundStyle(Theme.onBrand)
                .background(Theme.brandGradient, in: RoundedRectangle(cornerRadius: Theme.radius))
            }
            .buttonStyle(.plain)
            .disabled(app.signingIn)

            if let error = app.signInError {
                Text(error)
                    .font(.parley.footnote)
                    .foregroundStyle(Theme.destructive)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("Email and password, Google, and Apple all work. Before any recording starts, Parley asks you to confirm everyone in the room has agreed to it.")
                .font(.parley.caption)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Link("Privacy Policy", destination: URL(string: "https://parley.tw/privacy/")!)
                .font(.parley.caption)
        }
        .frame(maxWidth: 420)
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
                .foregroundStyle(Theme.brandGradient)
                .accessibilityHidden(true)
            ProgressView().tint(Theme.primary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .accessibilityLabel("Loading Parley")
    }
}
