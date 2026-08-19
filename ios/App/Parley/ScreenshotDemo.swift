#if DEBUG

    import Foundation
    import ParleyKit
    import SwiftUI

    /// Deterministic demo state for App Store screenshots — DEBUG builds only.
    ///
    /// Why this exists: every signed-in screen the store listing needs is behind
    /// the sign-in gate, and the gate is behind a real account. Capturing used to
    /// mean signing a simulator into the review account by hand and tapping
    /// through five screens per language, which is (a) slow, (b) impossible to
    /// reproduce exactly next release, and (c) puts a live account's data one
    /// mis-tap away from a public screenshot. Here the whole set is a launch
    /// argument plus five URLs, and no network call is ever made.
    ///
    /// Everything below is invented. No real company, person, account, or meeting
    /// is represented, and the copy is written in both shipping languages so the
    /// en-US and zh-Hant screenshot sets each read natively — a translated-looking
    /// screenshot sells the product short in whichever store it lands in.
    ///
    /// Two ways in, one code path (`route(_:)`):
    ///
    ///     # scripted: the route travels with the launch, nothing else is involved
    ///     xcrun simctl launch <device> com.pathors.parley.ios \
    ///         -ParleyDemo signedIn -ParleyDemoRoute library
    ///
    ///     # by hand: re-route a running app without relaunching it
    ///     xcrun simctl openurl <device> parley://demo/library
    ///
    /// The capture script uses the launch argument because as of the iOS 26.5
    /// simulator runtime `openurl` raises a SpringBoard confirmation alert
    /// — `Open in "Parley"?` — that no `simctl` command can dismiss, so every
    /// routed frame came out as the launch tab behind a modal. A launch
    /// argument never leaves the process.
    ///
    /// Routes: `record`, `library`, `transcript`, `keyboard`, `settings`,
    /// `dictation`.
    @MainActor
    final class ScreenshotDemo: ObservableObject {
        static let shared = ScreenshotDemo()

        enum Tab: Hashable { case record, library, settings }

        @Published var tab: Tab = .record
        /// Library pushes the demo transcript when this flips.
        @Published var showTranscript = false
        /// Settings scrolls the voice-keyboard section into view.
        @Published var focusKeyboardSection = false

        /// `-ParleyDemo signedIn` seeds an account; `-ParleyDemo signedOut` runs
        /// the demo with the sign-in wall up (the welcome frame). Absent, the app
        /// behaves exactly as it does in a normal build.
        private static let mode = UserDefaults.standard.string(forKey: "ParleyDemo")
        static var isActive: Bool { mode != nil }
        static var startsSignedIn: Bool { mode == "signedIn" }

        /// `-ParleyDemoRoute <route>` routes the launch itself, with the same
        /// vocabulary as `parley://demo/<route>`. Absent, the app opens on the
        /// tab it normally opens on.
        private static let launchRoute = UserDefaults.standard.string(forKey: "ParleyDemoRoute")

        /// True when the app should answer from the fixtures below instead of the
        /// cloud. Guards every injection point so a normal DEBUG run is untouched.
        static var servesFixtures: Bool { isActive && startsSignedIn }

        private init() {
            // Applying the launch route here — not from a view — is what lets the
            // script skip `openurl`. Nothing observes these properties yet, so the
            // first value `MainTabs`/`LibraryView`/`SettingsView` see on subscribing
            // is already the routed one.
            if Self.isActive, let route = Self.launchRoute { self.route(route) }
        }

        /// Handles `parley://demo/…`. Returns false for everything else so the
        /// real `parley://` handlers (auth callback, dictation) still see it.
        @discardableResult
        func handle(_ url: URL) -> Bool {
            guard Self.isActive, url.scheme == "parley", url.host == "demo" else { return false }
            return route(url.pathComponents.last ?? "")
        }

        /// The routing table both entry points share. Returns false for an
        /// unknown route so `handle(_:)` can pass the URL on.
        @discardableResult
        func route(_ route: String) -> Bool {
            showTranscript = false
            focusKeyboardSection = false
            switch route {
            case "record": tab = .record
            case "library": tab = .library
            case "transcript":
                tab = .library
                showTranscript = true
            case "keyboard":
                tab = .settings
                focusKeyboardSection = true
            case "settings": tab = .settings
            case "dictation":
                // The keyboard hand-off screen in its stranded-listening state
                // (manual swipe-back, the iOS 26.4+ regime). Deferred a turn
                // because this route can run from `init`, which SwiftUI triggers
                // lazily while evaluating a body — and the coordinator is
                // observed by the app scene, which must not be mutated mid-update.
                Task { @MainActor in
                    DictationCoordinator.shared.seedDemoListening(
                        committed: Self.t(
                            "Hi Anna, just wanted to let you know that my new number is ",
                            "安納你好，跟你說一聲我的新電話號碼是"),
                        partial: Self.t("four zero eight", "零九一二"))
                }
            default: return false
            }
            return true
        }

        // MARK: language

        /// The demo copy follows the app's own localization so a zh-Hant capture
        /// is a Chinese screenshot all the way down, transcript included.
        private static var isChinese: Bool {
            (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
        }

        private static func t(_ en: String, _ zh: String) -> String { isChinese ? zh : en }

        // MARK: dictation fixture

        /// The dictation transcript, pre-chunked roughly the way the relay
        /// settles text. `DictationCoordinator.streamDemoTranscript` plays it
        /// back at speaking pace.
        static var dictationScript: [String] {
            let text = t(
                "Hi Anna, just wanted to let you know that my new number is 0912 345 678. Talk soon!",
                "嗨 Anna，跟你說一聲我的新電話號碼是 0912345678，之後再聊！")
            var chunks: [String] = []
            var current = ""
            for ch in text {
                current.append(ch)
                if current.count >= 3 {
                    chunks.append(current)
                    current = ""
                }
            }
            if !current.isEmpty { chunks.append(current) }
            return chunks
        }

        // MARK: account fixtures

        static let user = CloudUser(
            id: "demo-user", name: t("Alex Rivera", "李書瑋"),
            email: "alex@example.com", image: nil)

        static let orgs = [
            CloudOrg(
                id: "demo-org", name: t("Sales team", "業務團隊"),
                slug: "sales", role: "admin")
        ]

        static let quota = HostedQuota(
            plan: "free", sttSecondsUsed: 8_640, sttSecondsLimit: 36_000,
            llmCreditsUsed: 180, llmCreditsLimit: 500, periodResetTs: nil)

        static let folders = [
            CloudFolder(
                id: "f-renewals", name: t("Renewals", "續約"),
                orgId: nil, createdAt: nil, updatedAt: nil),
            CloudFolder(
                id: "f-new", name: t("New business", "新客戶"),
                orgId: nil, createdAt: nil, updatedAt: nil),
        ]

        // MARK: library fixtures

        /// Fixed clock so a re-capture months later produces the same frames.
        /// 2026-05-14 09:40 local, then walking backwards.
        private static let epoch: Double = 1_778_751_600_000

        static let recordings: [CloudRecordingSummary] = [
            CloudRecordingSummary(
                id: "demo-renewal",
                title: t("Renewal terms — Northwind", "續約條件討論 — 北風工業"),
                source: "live", createdAt: epoch, durationMs: 1_122_000,
                speakerCount: 2, findingsCount: 3, actionItemsCount: 2, hasAudio: true,
                snippet: t(
                    "Forty seats against an eighty-seat quote; price held through the next renewal.",
                    "四十席對上八十席的報價；價格鎖到下一次續約。"),
                folderId: "f-renewals", updatedAt: nil),
            CloudRecordingSummary(
                id: "demo-discovery",
                title: t("Discovery call — Halcyon Labs", "新客戶需求訪談 — 晴光實驗室"),
                source: "live", createdAt: epoch - 86_400_000, durationMs: 1_925_000,
                speakerCount: 3, findingsCount: 5, actionItemsCount: 4, hasAudio: true,
                snippet: t(
                    "Security questionnaire due Friday; invoicing split across two cost centres.",
                    "資安問卷週五前回覆；請款要拆成兩個成本中心。"),
                folderId: "f-new", updatedAt: nil),
            CloudRecordingSummary(
                id: "demo-review",
                title: t("Quarterly review — Meridian", "季度檢討 — 子午線"),
                source: "upload", createdAt: epoch - 5 * 86_400_000, durationMs: 2_831_000,
                speakerCount: 2, findingsCount: 2, actionItemsCount: 1, hasAudio: true,
                snippet: t(
                    "Usage up 22% quarter on quarter; two action items carried over.",
                    "使用量季增 22%；兩項待辦順延到下一季。"),
                folderId: nil, updatedAt: nil),
        ]

        static var featured: CloudRecordingSummary { recordings[0] }

        // MARK: transcript fixtures

        /// The renewal conversation, written the way a real B2B negotiation
        /// sounds — seat counts, a price hold, an onboarding estimate with a
        /// condition attached. A screenshot reading "test test test" tells a
        /// reviewer nothing about what the product does.
        private static var lines: [(speaker: Int, ms: UInt64, text: String)] {
            [
                (1, 12_000, t(
                    "We're happy with the platform overall. The blocker is the seat count — we budgeted for forty and the quote came back at eighty.",
                    "平台整體我們用得很滿意，卡住的是席次——我們編了四十席，但報價回來是八十席。")),
                (2, 27_000, t(
                    "Forty is the floor on the enterprise tier, so I can't go under it. What I can do is hold this year's price through the next renewal.",
                    "四十席是企業版的最低門檻，我沒辦法再往下。我能做的是把今年的價格鎖到下一次續約。")),
                (1, 44_000, t(
                    "A price hold helps. What about the onboarding time you mentioned last week — you said two weeks?",
                    "鎖價有幫助。那你上週提到的導入時間呢，你說兩週？")),
                (2, 58_000, t(
                    "Two weeks assumes your SSO is already on Okta. If it isn't, add a week for the identity mapping.",
                    "兩週的前提是你們的 SSO 已經在 Okta 上。如果不是，身分對應要再加一週。")),
                (1, 76_000, t(
                    "It is. Send the revised quote with the price hold in writing and I'll take it to finance on Thursday.",
                    "是在 Okta 上。你把含鎖價條款的修訂報價寄來，我週四拿去給財務。")),
                (2, 92_000, t(
                    "I'll have it to you tomorrow morning, and I'll include the security questionnaire your team asked for.",
                    "明天早上寄給你，並附上你們團隊要的資安問卷。")),
            ]
        }

        static var meta: RecordingMeta {
            RecordingMeta(raw: [
                "id": featured.id,
                "title": featured.title,
                "source": "live",
                "createdAt": featured.createdAt,
                "durationMs": featured.durationMs,
                "segments": lines.map { line in
                    [
                        "id": "mix-\(line.ms)", "source": "mix", "speaker": line.speaker,
                        "text": line.text, "isFinal": true,
                        "startMs": Double(line.ms), "endMs": Double(line.ms + 12_000),
                    ] as [String: Any]
                },
                "speakerNames": [
                    "mix-1": t("Client lead", "客戶窗口"),
                    "mix-2": t("You", "我"),
                ],
                "findings": [Any](), "actionItems": [Any](),
                "audio": "audio.ogg", "analyzed": true,
            ])
        }

        // MARK: live screen

        /// Fills the live screen with a recording already in progress: settled
        /// runs plus an unfinished tail, which is the state worth showing.
        static func seedLive(_ recorder: MeetingRecorder) {
            guard servesFixtures, recorder.segments.isEmpty else { return }
            var seeded: [TranscriptSegment] = lines.prefix(3).map { line in
                TranscriptSegment(
                    id: "mix-\(line.ms)", source: "mix", speaker: line.speaker,
                    text: line.text, isFinal: true,
                    startMs: line.ms, endMs: line.ms + 12_000)
            }
            seeded.append(
                TranscriptSegment(
                    id: "mix-tail", source: "mix", speaker: 2,
                    text: t(
                        "Two weeks assumes your SSO is already",
                        "兩週的前提是你們的 SSO 已經"),
                    isFinal: false, startMs: 58_000, endMs: 62_000))
            recorder.seedDemo(
                segments: seeded, status: String(localized: "Transcribing live"))
        }
    }

#endif
