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
    /// than a heading that happens to say "Parley": Alexandria, at 40pt, in ink.
    /// The gradient and the tinted disc behind the glyph are both gone — the mark
    /// is the name, set large, and it does not need a badge to be a hero.
    private var header: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityHidden(true)
            Text(verbatim: "Parley")
                .font(.parley.wordmark(size: 40))
                .foregroundStyle(Color(.label))
            Text("Record it. Hand it to the AI you already use.")
                .font(.parley.title3)
                .foregroundStyle(Color(.label))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Parley records in-person meetings, transcribes them live, and keeps them where your Mac and phone can both find them.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: what you get

    /// One line each: the three things the product does, in the order a
    /// meeting goes through them — record, file, hand off.
    private struct Point {
        let icon: String
        let title: LocalizedStringKey
    }

    private static let points: [Point] = [
        Point(
            icon: "record.circle",
            title: "Record and transcribe live, even from the lock screen"),
        Point(
            icon: "folder",
            title: "One customer, one folder, synced with your Mac"),
        Point(
            icon: "square.and.arrow.up",
            title: "Share to ChatGPT or Claude for analysis"),
    ]

    private func pointRow(_ point: Point) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: point.icon)
                .font(.parley.title3)
                .frame(width: 28)
                // Secondary, not blue: these three glyphs mark the list, they
                // are not happening now and there is nothing to tap. The only
                // blue on this screen is the button at the bottom.
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityHidden(true)
            Text(point.title)
                .font(.parley.bodyEmphasized)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: sign in

    /// The one filled blue surface left in the app.
    ///
    /// Blue is a signal, and a fill behind content is out — but this is not
    /// behind content, it *is* the content: the single action on the only screen
    /// that has one, and the distance between opening Parley and being able to
    /// record. Flat `primary`, not a gradient.
    private var callToAction: some View {
        VStack(spacing: 12) {
            Button {
                app.signIn()
            } label: {
                HStack(spacing: 8) {
                    if app.signingIn { ProgressView().tint(.white) }
                    Text(app.signingIn ? "Signing in…" : "Sign in or create an account")
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
                .foregroundStyle(Color(.secondaryLabel))
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
                .foregroundStyle(Color(.label))
                .accessibilityHidden(true)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .accessibilityLabel("Loading Parley")
    }
}
