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
                        ForEach(Self.points, id: \.title) { point in
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

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Theme.foreground)
                .accessibilityHidden(true)
            Text("Parley")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(Theme.foreground)
            Text("面對面會議的口袋錄音機——邊錄邊出逐字稿，講完就在雲端。")
                .font(.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: what you get

    private struct Point {
        let icon: String
        let title: String
        let detail: String
    }

    private static let points: [Point] = [
        Point(
            icon: "record.circle",
            title: "把手機放桌上就能錄",
            detail: "收整個房間的聲音，自動分辨不同說話者。"),
        Point(
            icon: "text.bubble",
            title: "即時轉錄，不必自備 API key",
            detail: "登入後就用我們代管的轉錄服務，免費額度足夠日常使用。"),
        Point(
            icon: "icloud",
            title: "錄音與逐字稿同步到你的帳號",
            detail: "手機錄的會議，桌面版打開就能做深度分析。"),
    ]

    private func pointRow(_ point: Point) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: point.icon)
                .font(.title3)
                .frame(width: 28)
                .foregroundStyle(Theme.foreground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(point.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.foreground)
                Text(point.detail)
                    .font(.footnote)
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
                    if app.signingIn { ProgressView().tint(Theme.primaryForeground) }
                    Text(app.signingIn ? "登入中…" : "登入或註冊")
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .foregroundStyle(Theme.primaryForeground)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.primary)
            .disabled(app.signingIn)

            if let error = app.signInError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.destructive)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("支援信箱密碼、Google 與 Apple 登入。開始錄音前，Parley 一定會先請你確認已取得所有與會者同意。")
                .font(.caption)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Link("隱私權政策", destination: URL(string: "https://parley.tw/privacy/")!)
                .font(.caption)
        }
        .frame(maxWidth: 420)
    }
}

/// Shown for the one moment between launch and the first `refreshSession()`
/// returning. Without it a returning user sees the sign-in wall flash by before
/// the stored session is confirmed.
struct LaunchView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform")
                .font(.system(size: 30))
                .foregroundStyle(Theme.mutedForeground)
                .accessibilityHidden(true)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .accessibilityLabel("正在載入 Parley")
    }
}
