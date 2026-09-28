package com.pathors.parley.kit

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json

/**
 * One in-app "What's New" announcement, as written in the JSON files of
 * `announcements/` at the repository root — iOS `Announcement` (ParleyKit), field for field.
 *
 * The folder is shared by every platform, so a release's copy is written once
 * and drifts in none of them. That is why the version it ships in is *per
 * platform* ([ships]): the apps are released on their own schedules, and an
 * announcement a platform never gets says so with a `null` rather than by being
 * absent from the folder. See `announcements/README.md` for the schema.
 *
 * Decoding is forgiving about the optional fields and about keys this build has
 * never heard of (a new platform under `ships`, say), and strict about nothing
 * else. What an older build does with a value it does not understand — an
 * audience, a hero id — is decided in [AnnouncementGate], not here.
 */
@Serializable
data class Announcement(
    /**
     * Stable and unique across the folder. By convention it starts with the
     * month it shipped (`2026-10-polish-wave`), which also makes it a sensible
     * tie-break when two announcements ship in the same version.
     */
    val id: String,
    val ships: Ships,
    /** Absent means [AnnouncementAudience.All]. */
    val audience: AnnouncementAudience? = null,
    /**
     * An id each platform looks up in its own registry of native hero views.
     * Android's registry is empty today; unknown or absent draws no hero, and
     * the sheet is complete without one.
     */
    val hero: String? = null,
    val cta: CallToAction? = null,
    /** Keyed by locale: `zh-Hant` and `en`, both required (the catalogue test enforces it). */
    val copy: Map<String, Copy>,
) {
    /** The version each platform ships it in. `null` means never shown there. */
    @Serializable
    data class Ships(
        val ios: String? = null,
        val android: String? = null,
        val desktop: String? = null,
    )

    /**
     * A per-platform deep link for the sheet's one button. `null` means the
     * button just closes the sheet.
     */
    @Serializable
    data class CallToAction(
        val ios: String? = null,
        val android: String? = null,
    )

    /** Everything the sheet says, in one language. */
    @Serializable
    data class Copy(
        /** The small line above the title — "1.22 更新" / "New in 1.22". */
        val badge: String,
        val title: String,
        val body: String,
        /** The one-line "also changed" footnote under the divider. */
        val also: String,
        /** The button's label. */
        val button: String,
    ) {
        /** Every field, for the checks that have to hold for all of them. */
        val fields: List<String> get() = listOf(badge, title, body, also, button)
    }

    /**
     * The copy for the app's UI language: Traditional Chinese for any `zh`
     * tag — the app ships no Simplified, so a Chinese UI *is* the Traditional
     * one — and English for everything else. Falls back to English if the file
     * is missing the Chinese, so a half-written entry shows the wrong language
     * rather than nothing.
     */
    fun copyFor(language: String): Copy? {
        val key = if (language.startsWith("zh")) TRADITIONAL_CHINESE else ENGLISH
        return copy[key] ?: copy[ENGLISH]
    }

    companion object {
        /** The two locales every announcement carries. */
        const val TRADITIONAL_CHINESE = "zh-Hant"
        const val ENGLISH = "en"
    }
}

/**
 * Who an announcement is for.
 *
 * A string on disk, a closed type here with a catch-all: a future file may name
 * an audience this build predates, and the right thing for an older build to do
 * with a condition it cannot evaluate is to treat it as unmet — never to fail
 * the whole file, and never to show the announcement to everyone.
 */
@Serializable(with = AnnouncementAudience.Serializer::class)
sealed interface AnnouncementAudience {
    val rawValue: String

    /** Everyone upgrading. */
    data object All : AnnouncementAudience {
        override val rawValue = "all"
    }

    /** Only people who have used the Parley keyboard on this device (iOS only). */
    data object Keyboard : AnnouncementAudience {
        override val rawValue = "keyboard"
    }

    data class Unknown(override val rawValue: String) : AnnouncementAudience

    companion object {
        fun of(rawValue: String): AnnouncementAudience = when (rawValue) {
            All.rawValue -> All
            Keyboard.rawValue -> Keyboard
            else -> Unknown(rawValue)
        }
    }

    object Serializer : KSerializer<AnnouncementAudience> {
        override val descriptor: SerialDescriptor =
            PrimitiveSerialDescriptor("AnnouncementAudience", PrimitiveKind.STRING)

        override fun deserialize(decoder: Decoder): AnnouncementAudience = of(decoder.decodeString())

        override fun serialize(encoder: Encoder, value: AnnouncementAudience) {
            encoder.encodeString(value.rawValue)
        }
    }
}

/**
 * A marketing version (`versionName`), compared the way people read it:
 * component by component, numerically, with missing components as zero. So
 * `1.9 < 1.10` (a string compare gets that backwards) and `1.22 == 1.22.0`.
 *
 * A component that is not a number reads its leading digits (`"3-beta"` is 3)
 * and an empty one is 0. Only [parse] refuses, and only a string with no digit
 * anywhere in it — the caller then shows nothing, which is the only safe
 * reading of a version it cannot place.
 */
class AppVersion private constructor(val components: List<Int>) : Comparable<AppVersion> {

    override fun compareTo(other: AppVersion): Int {
        val count = maxOf(components.size, other.components.size)
        for (index in 0 until count) {
            val a = components.getOrElse(index) { 0 }
            val b = other.components.getOrElse(index) { 0 }
            if (a != b) return a.compareTo(b)
        }
        return 0
    }

    override fun equals(other: Any?): Boolean = other is AppVersion && compareTo(other) == 0

    /** Consistent with [equals]: trailing zeros do not count. */
    override fun hashCode(): Int = components.dropLastWhile { it == 0 }.hashCode()

    override fun toString(): String = components.joinToString(".")

    companion object {
        fun parse(string: String): AppVersion? {
            val trimmed = string.trim()
            if (trimmed.none { it.isDigit() }) return null
            return AppVersion(
                trimmed.split('.').map { part ->
                    part.takeWhile { it.isDigit() }.toIntOrNull() ?: 0
                },
            )
        }
    }
}

/**
 * Reads an `announcements/` folder's files. The app hands it the bundled
 * assets and the tests the repository copy; both go through here so the two can
 * never disagree about what a valid file is.
 */
object AnnouncementCatalog {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Every announcement among [files] (file name → contents): the `*.json`
     * ones, in file-name order. A file that does not decode is skipped rather
     * than taking the rest down with it — in a shipped build that is one
     * missing sheet, not a missing feature; the test over the repository
     * folder is what makes sure no such file is ever committed.
     */
    fun load(files: Map<String, String>): List<Announcement> =
        files.entries
            .filter { it.key.endsWith(".json") }
            .sortedBy { it.key }
            .mapNotNull { runCatching { decode(it.value) }.getOrNull() }

    fun decode(text: String): Announcement = json.decodeFromString(Announcement.serializer(), text)
}
