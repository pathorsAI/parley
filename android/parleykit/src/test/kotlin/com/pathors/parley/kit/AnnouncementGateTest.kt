package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * iOS `AnnouncementGateTests`, case for case, with Android's version
 * (`ships.android`) and Android's audiences (no keyboard).
 */
class AnnouncementGateTest {

    private fun item(
        id: String,
        android: String?,
        ios: String? = null,
        desktop: String? = null,
        audience: AnnouncementAudience? = null,
    ): Announcement {
        val copy = Announcement.Copy(badge = "b", title = "t", body = "x", also = "a", button = "ok")
        return Announcement(
            id = id,
            ships = Announcement.Ships(ios = ios, android = android, desktop = desktop),
            audience = audience,
            copy = mapOf(Announcement.ENGLISH to copy, Announcement.TRADITIONAL_CHINESE to copy),
        )
    }

    private fun decide(
        announcements: List<Announcement>,
        state: AnnouncementState = AnnouncementState(),
        appVersion: String,
    ) = AnnouncementGate.decide(announcements, state, appVersion)

    // first launch

    @Test
    fun `a new install sees nothing and has everything marked seen`() {
        val bundled = listOf(item("a", android = "1.16"), item("b", android = "1.30"))

        val state = AnnouncementGate.initial(bundled, hadStoredSession = false)

        assertEquals(setOf("a", "b"), state.seen)
        assertEquals(AnnouncementGate.Decision.NOTHING, decide(bundled, state, "1.16"))
    }

    @Test
    fun `an existing user upgrading is shown it`() {
        val bundled = listOf(item("a", android = "1.16"))

        val state = AnnouncementGate.initial(bundled, hadStoredSession = true)
        val decision = decide(bundled, state, "1.16")

        assertEquals(emptySet<String>(), state.seen)
        assertEquals("a", decision.show?.id)
        assertEquals(setOf("a"), decision.retire)
    }

    // versions

    @Test
    fun `an announcement for a later version waits`() {
        assertEquals(
            AnnouncementGate.Decision.NOTHING,
            decide(listOf(item("a", android = "1.17")), appVersion = "1.16"),
        )
    }

    @Test
    fun `an earlier version still shows to someone who skipped it`() {
        assertEquals("a", decide(listOf(item("a", android = "1.9")), appVersion = "1.10").show?.id)
    }

    @Test
    fun `other platforms' versions are irrelevant on Android`() {
        val androidToo = item("a", android = "1.16")
        val iosOnly = item("b", android = null, ios = "1.24", desktop = "0.9")

        val decision = decide(listOf(androidToo, iosOnly), appVersion = "9.0")

        assertEquals("a", decision.show?.id)
        assertEquals("an iOS-only entry is not ours to retire", setOf("a"), decision.retire)
        assertEquals(AnnouncementGate.Decision.NOTHING, decide(listOf(iosOnly), appVersion = "9.0"))
    }

    @Test
    fun `an unreadable app version shows nothing`() {
        assertEquals(
            AnnouncementGate.Decision.NOTHING,
            decide(listOf(item("a", android = "1.0")), appVersion = ""),
        )
    }

    // several at once

    @Test
    fun `only the newest shows and the older ones are retired with it`() {
        val bundled = listOf(
            item(OLD, android = "1.14"),
            item(NEW, android = "1.16"),
            item(MID, android = "1.15"),
            item(FUTURE, android = "1.18"),
        )

        val decision = decide(bundled, appVersion = "1.16.1")

        assertEquals(NEW, decision.show?.id)
        assertEquals(setOf(OLD, MID, NEW), decision.retire)
    }

    @Test
    fun `two in the same version break the tie on the later id`() {
        val decision = decide(
            listOf(item(SAME_VERSION_LATER, android = "1.16"), item(SAME_VERSION_EARLIER, android = "1.16")),
            appVersion = "1.16",
        )

        assertEquals(SAME_VERSION_LATER, decision.show?.id)
        assertEquals(setOf(SAME_VERSION_EARLIER, SAME_VERSION_LATER), decision.retire)
    }

    // audience

    @Test
    fun `a keyboard announcement never shows on Android`() {
        val bundled = listOf(item("kb", android = "1.16", audience = AnnouncementAudience.Keyboard))

        assertEquals(AnnouncementGate.Decision.NOTHING, decide(bundled, appVersion = "1.16"))
    }

    @Test
    fun `an unmet audience falls back to the newest one that is met`() {
        val bundled = listOf(
            item(OLDER_FOR_ALL, android = "1.15"),
            item(NEWER_KEYBOARD, android = "1.16", audience = AnnouncementAudience.Keyboard),
        )

        val decision = decide(bundled, appVersion = "1.16")

        assertEquals(OLDER_FOR_ALL, decision.show?.id)
        assertEquals("the newer keyboard one is left alone", setOf(OLDER_FOR_ALL), decision.retire)
    }

    @Test
    fun `a newer announcement retires an older one whose audience is unmet`() {
        val bundled = listOf(
            item(OLDER_KEYBOARD, android = "1.15", audience = AnnouncementAudience.Keyboard),
            item(NEWER_FOR_ALL, android = "1.16", audience = AnnouncementAudience.All),
        )

        val decision = decide(bundled, appVersion = "1.16")

        assertEquals(NEWER_FOR_ALL, decision.show?.id)
        assertEquals(setOf(OLDER_KEYBOARD, NEWER_FOR_ALL), decision.retire)
    }

    @Test
    fun `an audience this build does not know is unmet`() {
        val decoded = AnnouncementCatalog.decode(
            """{"id":"x","ships":{"android":"1.0"},"audience":"watch","copy":{}}""",
        )

        assertEquals(AnnouncementAudience.Unknown("watch"), decoded.audience)
        assertEquals(AnnouncementGate.Decision.NOTHING, decide(listOf(decoded), appVersion = "1.0"))
    }

    // seen

    @Test
    fun `a seen announcement is never shown again`() {
        assertEquals(
            AnnouncementGate.Decision.NOTHING,
            decide(listOf(item("a", android = "1.16")), AnnouncementState(setOf("a")), "1.16"),
        )
    }

    // decoding

    @Test
    fun `optional fields and unknown keys decode`() {
        val decoded = AnnouncementCatalog.decode(
            """
            {"id":"x","ships":{"ios":"1.0","watchos":"2.0"},"future":true,
             "cta":{"ios":"parley://a","android":"parley://b","web":"https://c"},
             "copy":{"en":{"badge":"b","title":"t","body":"x","also":"a","button":"ok"}}}
            """.trimIndent(),
        )

        assertNull(decoded.ships.android)
        assertNull(decoded.audience)
        assertNull(decoded.hero)
        assertEquals("parley://b", decoded.cta?.android)
    }

    @Test
    fun `a broken file is skipped rather than taking the rest down`() {
        val good = """{"id":"b","ships":{},"copy":{}}"""
        val loaded = AnnouncementCatalog.load(
            mapOf("b.json" to good, "a.json" to "{ not json", "README.md" to "# hi", "c.json" to good),
        )

        assertEquals(listOf("b", "b"), loaded.map { it.id })
    }

    // copy

    @Test
    fun `copy follows the UI language`() {
        val zh = Announcement.Copy(badge = "中", title = "中", body = "中", also = "中", button = "好")
        val en = Announcement.Copy(badge = "en", title = "en", body = "en", also = "en", button = "OK")
        val announcement = Announcement(
            id = "a",
            ships = Announcement.Ships(android = "1.0"),
            copy = mapOf(Announcement.TRADITIONAL_CHINESE to zh, Announcement.ENGLISH to en),
        )

        assertEquals(zh, announcement.copyFor(Announcement.TRADITIONAL_CHINESE))
        assertEquals(zh, announcement.copyFor("zh-TW"))
        assertEquals(zh, announcement.copyFor("zh"))
        assertEquals(en, announcement.copyFor(Announcement.ENGLISH))
        assertEquals(en, announcement.copyFor("ja"))

        val englishOnly = announcement.copy(copy = mapOf(Announcement.ENGLISH to en))
        assertEquals("a missing Chinese falls back to English", en, englishOnly.copyFor("zh-TW"))
    }

    // version comparison

    @Test
    fun `versions compare numerically by component`() {
        fun v(s: String) = AppVersion.parse(s)!!

        assertTrue(v("1.9") < v("1.10"))
        assertEquals(v("1.22"), v("1.22.0"))
        assertEquals("trailing zeros never count", v("1.22" + ".0".repeat(2)), v("1.22"))
        assertEquals(v("1.22").hashCode(), v("1.22.0").hashCode())
        assertTrue(v("1.22") < v("1.22.1"))
        assertTrue(v("1.99") < v("2"))
        assertTrue(v("10.0") > v("9.9.9"))
        assertEquals(v("1.22-beta"), v("1.22"))
        assertNull(AppVersion.parse(""))
        assertNull(AppVersion.parse("beta"))
    }

    private companion object {
        const val NEW = "2026-10-new"
        const val SAME_VERSION_LATER = "2026-10-b"
        const val SAME_VERSION_EARLIER = "2026-10-a"
        const val OLDER_FOR_ALL = "2026-09-all"
        const val NEWER_FOR_ALL = "2026-10-all"
        const val OLDER_KEYBOARD = "2026-09-kb"
        const val NEWER_KEYBOARD = "2026-10-kb"
        const val OLD = "2026-08-old"
        const val MID = "2026-09-mid"
        const val FUTURE = "2026-12-future"
    }
}
