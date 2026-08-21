package com.pathors.parley.screenshot

import android.net.Uri
import com.pathors.parley.BuildConfig
import com.pathors.parley.cloud.CloudUser
import com.pathors.parley.cloud.HostedQuota
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.TranscriptSegment
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Deterministic demo state for Play Store screenshots — debug builds only.
 *
 * Why this exists: every screen the store listing needs is behind the sign-in
 * wall, and the wall is behind a real account. Capturing by hand means signing a
 * device into a live account, which is (a) slow, (b) impossible to reproduce
 * exactly next release, and (c) puts real customer data one mis-tap away from a
 * public store listing. This is the Android half of iOS
 * `ios/App/Parley/ScreenshotDemo.swift`, and it makes the same three promises:
 *
 *  1. **Signed in without a token.** [enabled] short-circuits the sign-in wall in
 *     `ParleyRoot`; nothing is ever written to the auth DataStore.
 *  2. **No network, ever.** Every cloud call the UI would make is answered from
 *     the fixtures below, so a reviewer's (or CI's) offline machine captures the
 *     same frames as a connected one, and production is never touched.
 *  3. **No residue.** The flag and the navigation cue live in memory only. There
 *     is no disk write, no pending-upload queue entry, no notification, no
 *     microphone. `parley://demo/off` (or a process restart) leaves the app
 *     exactly as it was.
 *
 * Driven entirely by deep links, the way iOS is driven by `simctl openurl` —
 * input automation on an emulator is unreliable, `am start` is not:
 *
 * ```
 * adb shell am start -a android.intent.action.VIEW -d "'parley://demo/library'"
 * ```
 *
 * Routes: `library`, `transcript`, `record` (alias `meeting`), `account`
 * (alias `settings`), and `off`.
 *
 * Everything below is invented. No real company, person, account, or meeting is
 * represented, the only address is in the RFC-reserved `example.com`, and the
 * copy is written separately in English and Traditional Chinese — a screenshot
 * set that reads like a translation sells the product short in whichever store
 * it lands in.
 */
object DemoMode {

    /** The screens the listing needs, each addressable by its own URL. */
    enum class Screen { LIBRARY, TRANSCRIPT, MEETING, ACCOUNT }

    /**
     * A navigation request. [serial] makes each one distinct so firing the same
     * URL twice re-navigates instead of being swallowed as "no change".
     */
    data class Navigation(val screen: Screen, val serial: Long)

    private val _enabled = MutableStateFlow(false)

    /** Whether the app is serving fixtures instead of the cloud. */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private val _navigation = MutableStateFlow<Navigation?>(null)

    /** The screen the last `parley://demo/…` asked for. */
    val navigation: StateFlow<Navigation?> = _navigation.asStateFlow()

    private var serial = 0L

    /** Cheap synchronous read for the non-Compose injection points. */
    val isActive: Boolean get() = _enabled.value

    /**
     * Handle a `parley://demo/…` deep link. Returns false for anything else — a
     * sign-in callback, or any route in a release build — so `MainActivity`'s
     * real handler still sees it.
     */
    fun handle(uri: Uri): Boolean {
        if (!BuildConfig.DEBUG) return false
        if (uri.scheme != SCHEME || uri.host != HOST) return false
        val route = uri.pathSegments.lastOrNull().orEmpty()
        if (route == ROUTE_OFF) {
            disable()
            return true
        }
        val screen = when (route) {
            "library", "recordings" -> Screen.LIBRARY
            "transcript", "recording" -> Screen.TRANSCRIPT
            "record", "meeting" -> Screen.MEETING
            "account", "settings" -> Screen.ACCOUNT
            else -> return false
        }
        _enabled.value = true
        serial += 1
        _navigation.value = Navigation(screen, serial)
        return true
    }

    /** Leave demo mode. In-memory only, so this is the whole clean-up. */
    fun disable() {
        _enabled.value = false
        _navigation.value = null
    }

    // ── language ─────────────────────────────────────────────────────────────

    /**
     * The demo copy follows the device locale, because the screenshot sets are
     * captured per-locale: a zh-TW capture has to be a Chinese screenshot all the
     * way down, transcript included.
     */
    private fun isChinese(locale: Locale): Boolean = locale.language == "zh"

    private fun t(locale: Locale, en: String, zh: String): String =
        if (isChinese(locale)) zh else en

    // ── account fixtures ─────────────────────────────────────────────────────

    fun user(locale: Locale = Locale.getDefault()): CloudUser = CloudUser(
        id = "demo-user",
        name = t(locale, "Alex Rivera", "李書瑋"),
        email = "alex@example.com",
    )

    fun quota(): HostedQuota = HostedQuota(
        plan = "free",
        sttSecondsUsed = 8_640.0,
        sttSecondsLimit = 36_000.0,
        llmCreditsUsed = 180.0,
        llmCreditsLimit = 500.0,
        periodResetTs = EPOCH_MS + 18 * DAY_MS,
    )

    // ── library fixtures ─────────────────────────────────────────────────────

    /** The recording the `transcript` route opens: the fully analyzed one. */
    const val FEATURED_ID = "demo-renewal"

    private const val DISCOVERY_ID = "demo-discovery"
    private const val REVIEW_ID = "demo-review"

    fun recordings(locale: Locale = Locale.getDefault()): List<RecordingSummary> = listOf(
        RecordingSummary(
            id = FEATURED_ID,
            title = t(locale, "Renewal terms — Northwind", "續約條件討論 — 北風工業"),
            source = RecordingSource.LIVE,
            createdAt = EPOCH_MS,
            durationMs = 1_122_000.0,
            speakerCount = 2,
            findingsCount = 3,
            actionItemsCount = 2,
            hasAudio = true,
            snippet = t(
                locale,
                "Forty seats against an eighty-seat quote; price held through the next renewal.",
                "四十席對上八十席的報價；價格鎖到下一次續約。",
            ),
        ),
        RecordingSummary(
            id = DISCOVERY_ID,
            title = t(locale, "Discovery call — Halcyon Labs", "新客戶需求訪談 — 晴光實驗室"),
            source = RecordingSource.LIVE,
            createdAt = EPOCH_MS - DAY_MS,
            durationMs = 1_925_000.0,
            speakerCount = 3,
            findingsCount = 2,
            actionItemsCount = 1,
            hasAudio = true,
            snippet = t(
                locale,
                "Security questionnaire due Friday; invoicing split across two cost centres.",
                "資安問卷週五前回覆；請款要拆成兩個成本中心。",
            ),
        ),
        RecordingSummary(
            id = REVIEW_ID,
            title = t(locale, "Quarterly review — Meridian", "季度檢討 — 子午線"),
            source = RecordingSource.UPLOAD,
            createdAt = EPOCH_MS - 5 * DAY_MS,
            durationMs = 2_831_000.0,
            speakerCount = 2,
            findingsCount = 0,
            actionItemsCount = 0,
            hasAudio = true,
            snippet = t(
                locale,
                "Usage up 22% quarter on quarter; two action items carried over.",
                "使用量季增 22%；兩項待辦順延到下一季。",
            ),
        ),
    )

    /** The meta the detail screen renders, or null for an id we don't have. */
    fun meta(id: String, locale: Locale = Locale.getDefault()): RecordingMeta? {
        val summary = recordings(locale).firstOrNull { it.id == id } ?: return null
        return RecordingMeta(
            buildJsonObject {
                put("id", summary.id)
                put("title", summary.title)
                put("source", summary.source)
                put("createdAt", summary.createdAt.toLong())
                put("durationMs", summary.durationMs.toLong())
                put("audio", "audio.ogg")
                put("analyzed", summary.findingsCount != 0)
                putJsonObject("speakerNames") {
                    speakerNames(id, locale).forEach { (key, name) -> put(key, name) }
                }
                putJsonArray("segments") {
                    lines(id, locale).forEach { line ->
                        addJsonObject {
                            put("id", "mix-${line.index}")
                            put("source", "mix")
                            put("speaker", line.speaker)
                            put("text", line.text)
                            put("isFinal", true)
                            put("startMs", line.atMs)
                            put("endMs", line.atMs + LINE_LENGTH_MS)
                        }
                    }
                }
                putJsonArray("findings") {
                    findings(id, locale).forEach { finding ->
                        addJsonObject {
                            put("title", finding.title)
                            put("detail", finding.detail)
                            put("atMs", finding.atMs)
                            put("severity", finding.severity)
                        }
                    }
                }
                putJsonArray("actionItems") {
                    actionItems(id, locale).forEach { item ->
                        addJsonObject {
                            put("text", item.text)
                            put("rationale", item.rationale)
                            put("done", false)
                        }
                    }
                }
            }
        )
    }

    private fun speakerNames(id: String, locale: Locale): Map<String, String> = when (id) {
        DISCOVERY_ID -> mapOf(
            "mix-1" to t(locale, "Head of platform", "平台負責人"),
            "mix-2" to t(locale, "You", "我"),
            "mix-3" to t(locale, "Security lead", "資安主管"),
        )

        else -> mapOf(
            "mix-1" to t(locale, "Client lead", "客戶窗口"),
            "mix-2" to t(locale, "You", "我"),
        )
    }

    // ── transcript fixtures ──────────────────────────────────────────────────

    private data class Line(val index: Int, val speaker: Int, val atMs: Long, val text: String)

    /**
     * The conversations, written the way B2B calls actually sound — a seat count
     * against a quote, a price hold, an onboarding estimate with a condition
     * attached. A screenshot reading "test test test" tells a reviewer nothing
     * about what the product does.
     */
    private fun lines(id: String, locale: Locale): List<Line> = when (id) {
        DISCOVERY_ID -> listOf(
            Line(
                1, 1, 9_000,
                t(
                    locale,
                    "We run about thirty calls a week across two teams, and nobody writes them up. That's the problem we're trying to solve.",
                    "我們兩個團隊一週大概三十通會議，但沒有人做紀錄，這就是我們想解決的問題。",
                ),
            ),
            Line(
                2, 2, 31_000,
                t(
                    locale,
                    "Then the place to start is the transcript, not the summary — people trust a summary once they can check it against what was said.",
                    "那就從逐字稿開始，而不是摘要——大家要能對照原話，才會信任摘要。",
                ),
            ),
            Line(
                3, 3, 52_000,
                t(
                    locale,
                    "Before any of that, I need the security questionnaire back. Friday, or this slips to next quarter.",
                    "在那之前，我需要先拿回資安問卷。週五前，不然就要拖到下一季。",
                ),
            ),
            Line(
                4, 2, 74_000,
                t(
                    locale,
                    "Friday works. One thing to flag: your invoicing has to be split across two cost centres, so I'll set that up before the trial starts.",
                    "週五沒問題。有一件事要先講：你們的請款要拆成兩個成本中心，我會在試用開始前先設定好。",
                ),
            ),
        )

        REVIEW_ID -> listOf(
            Line(
                1, 1, 14_000,
                t(
                    locale,
                    "Usage is up twenty-two percent quarter on quarter, and almost all of it came from the two teams that onboarded in March.",
                    "使用量季增二十二個百分點，而且幾乎都來自三月導入的那兩個團隊。",
                ),
            ),
            Line(
                2, 2, 38_000,
                t(
                    locale,
                    "That matches what we saw. The two action items from last quarter are still open — both are waiting on your IT team.",
                    "跟我們看到的一致。上一季的兩項待辦還沒關掉，兩件都卡在你們的 IT。",
                ),
            ),
            Line(
                3, 1, 61_000,
                t(
                    locale,
                    "Carry them over. I'd rather close them properly next quarter than mark them done today.",
                    "順延吧。我寧可下一季好好收掉，也不要今天硬把它們標成完成。",
                ),
            ),
        )

        else -> listOf(
            Line(
                1, 1, 12_000,
                t(
                    locale,
                    "We're happy with the platform overall. The blocker is the seat count — we budgeted for forty and the quote came back at eighty.",
                    "平台整體我們用得很滿意，卡住的是席次——我們編了四十席，但報價回來是八十席。",
                ),
            ),
            Line(
                2, 2, 27_000,
                t(
                    locale,
                    "Forty is the floor on the enterprise tier, so I can't go under it. What I can do is hold this year's price through the next renewal.",
                    "四十席是企業版的最低門檻，我沒辦法再往下。我能做的是把今年的價格鎖到下一次續約。",
                ),
            ),
            Line(
                3, 1, 44_000,
                t(
                    locale,
                    "A price hold helps. What about the onboarding time you mentioned last week — you said two weeks?",
                    "鎖價有幫助。那你上週提到的導入時間呢，你說兩週？",
                ),
            ),
            Line(
                4, 2, 58_000,
                t(
                    locale,
                    "Two weeks assumes your SSO is already on Okta. If it isn't, add a week for the identity mapping.",
                    "兩週的前提是你們的 SSO 已經在 Okta 上。如果不是，身分對應要再加一週。",
                ),
            ),
            Line(
                5, 1, 76_000,
                t(
                    locale,
                    "It is. Send the revised quote with the price hold in writing and I'll take it to finance on Thursday.",
                    "是在 Okta 上。你把含鎖價條款的修訂報價寄來，我週四拿去給財務。",
                ),
            ),
            Line(
                6, 2, 92_000,
                t(
                    locale,
                    "I'll have it to you tomorrow morning, and I'll include the security questionnaire your team asked for.",
                    "明天早上寄給你，並附上你們團隊要的資安問卷。",
                ),
            ),
        )
    }

    // ── analysis fixtures ────────────────────────────────────────────────────

    private data class Finding(
        val title: String,
        val detail: String,
        val atMs: Long,
        val severity: String,
    )

    private data class ActionItem(val text: String, val rationale: String)

    private fun findings(id: String, locale: Locale): List<Finding> = when (id) {
        FEATURED_ID -> listOf(
            Finding(
                t(locale, "Seat count is the only blocker", "唯一的卡點是席次"),
                t(
                    locale,
                    "Forty seats budgeted against an eighty-seat quote. Everything else about the renewal was already agreed.",
                    "編列四十席，報價卻是八十席。續約的其他條件其實都談定了。",
                ),
                12_000, "high",
            ),
            Finding(
                t(locale, "A price hold replaced a discount", "用鎖價取代了折扣"),
                t(
                    locale,
                    "Holding this year's rate through the next renewal kept the conversation moving without cutting below the enterprise seat floor.",
                    "把今年的價格鎖到下一次續約，讓談判繼續往前，又不必跌破企業版的席次門檻。",
                ),
                27_000, "medium",
            ),
            Finding(
                t(locale, "The onboarding estimate has a condition", "導入時程附帶條件"),
                t(
                    locale,
                    "Two weeks assumes SSO is already on Okta; add a week for identity mapping if it isn't. The customer confirmed it is.",
                    "兩週的前提是 SSO 已在 Okta 上；若不是，身分對應要再加一週。客戶已確認是。",
                ),
                58_000, "low",
            ),
        )

        DISCOVERY_ID -> listOf(
            Finding(
                t(locale, "The security questionnaire gates the timeline", "資安問卷決定了時程"),
                t(
                    locale,
                    "Friday is a hard date — missing it pushes the whole evaluation into next quarter.",
                    "週五是硬期限，錯過就整個評估拖到下一季。",
                ),
                52_000, "high",
            ),
            Finding(
                t(locale, "Billing needs two cost centres", "請款需要拆成兩個成本中心"),
                t(
                    locale,
                    "Raised as an aside, but it has to be set up before the trial starts or the first invoice bounces internally.",
                    "只是順口提到，但要在試用開始前設定好，否則第一張帳單在他們內部就會被退。",
                ),
                74_000, "medium",
            ),
        )

        else -> emptyList()
    }

    private fun actionItems(id: String, locale: Locale): List<ActionItem> = when (id) {
        FEATURED_ID -> listOf(
            ActionItem(
                t(
                    locale,
                    "Send the revised quote with the price hold in writing",
                    "寄出含鎖價條款的修訂報價",
                ),
                t(
                    locale,
                    "Finance reviews it on Thursday, so it has to land Wednesday at the latest.",
                    "財務週四要審，最晚週三要送到。",
                ),
            ),
            ActionItem(
                t(
                    locale,
                    "Attach the security questionnaire to the same email",
                    "同一封信附上資安問卷",
                ),
                t(
                    locale,
                    "Their team asked for it directly, and it gates their internal sign-off.",
                    "對方團隊直接要的，而且他們的內部核准卡在這份文件。",
                ),
            ),
        )

        DISCOVERY_ID -> listOf(
            ActionItem(
                t(locale, "Return the security questionnaire by Friday", "週五前回覆資安問卷"),
                t(
                    locale,
                    "Named as the gate on the whole evaluation timeline.",
                    "對方明講這是整個評估時程的關卡。",
                ),
            ),
        )

        else -> emptyList()
    }

    // ── live meeting fixture ─────────────────────────────────────────────────

    /**
     * The renewal conversation again, this time as live segments for
     * [DemoMeetingSession] to play back on a timer — the live screen has to be
     * capturable on an emulator with no microphone and no audio input.
     */
    fun liveScript(locale: Locale = Locale.getDefault()): List<TranscriptSegment> =
        lines(FEATURED_ID, locale).map { line ->
            TranscriptSegment(
                id = "mix-${line.index}",
                source = "mix",
                speaker = line.speaker,
                text = line.text,
                isFinal = true,
                startMs = line.atMs,
                endMs = line.atMs + LINE_LENGTH_MS,
            )
        }

    /** The unfinished tail: what the relay has heard but not settled yet. */
    fun liveTail(locale: Locale = Locale.getDefault()): TranscriptSegment = TranscriptSegment(
        id = "mix-tail",
        source = "mix",
        speaker = 1,
        text = t(
            locale,
            "So if we sign this week, when could your team actually",
            "所以如果我們這週簽，你們團隊實際上什麼時候能",
        ),
        isFinal = false,
        startMs = 108_000,
        endMs = 112_000,
    )

    // ── dictation fixture ────────────────────────────────────────────────────

    /**
     * A dictated sentence, in the small pieces a speech recognizer actually
     * delivers — the fixture [com.pathors.parley.voicetyping.VoiceTypingSession]
     * plays back instead of opening a microphone while demo mode is on.
     *
     * The Android half of iOS `ScreenshotDemo.dictationScript`, and it exists for
     * the same two reasons: the keyboard has to be capturable for the store, and
     * an emulator has no microphone input at all — so this is the only way to
     * exercise the real commit path (segments → composing/committed text →
     * `InputConnection`) on a machine with no mic and no account. Only the
     * *source* is faked; every piece downstream of it is production code.
     */
    fun dictationScript(locale: Locale = Locale.getDefault()): List<String> =
        if (isChinese(locale)) {
            listOf(
                "跟財務", "確認過了，", "修訂報價", "今天下午", "就能寄出，",
                "含鎖價", "條款。",
            )
        } else {
            listOf(
                "Confirmed ", "with finance ", "— the revised ", "quote goes ",
                "out this ", "afternoon, ", "price hold ", "included.",
            )
        }

    private const val SCHEME = "parley"
    private const val HOST = "demo"
    private const val ROUTE_OFF = "off"

    /** A fixed clock, so a re-capture months later produces identical frames. */
    private const val EPOCH_MS = 1_786_498_800_000.0

    private const val DAY_MS = 86_400_000.0
    private const val LINE_LENGTH_MS = 12_000L
}
