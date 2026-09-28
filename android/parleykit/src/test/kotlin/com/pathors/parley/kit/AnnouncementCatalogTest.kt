package com.pathors.parley.kit

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The repository's `announcements/` folder, as the app will read it — iOS
 * `AnnouncementCatalogTests`, over the same files.
 *
 * Read from the working tree rather than a copy, for the same reason
 * `SampleManifestTest` reads `public/sample`: the file under test is the one
 * that ships (`copyAnnouncementAssets` bundles this folder into the APK).
 */
class AnnouncementCatalogTest {

    /** Unit tests run with the module directory (`android/parleykit`) as the working directory. */
    private val folder = File("../../announcements")

    private fun files(): List<File> {
        assertTrue("not found from ${File("").absolutePath}: $folder", folder.isDirectory)
        return folder.listFiles { file -> file.extension == "json" }.orEmpty().sortedBy { it.name }
    }

    @Test
    fun `the folder is there and not empty`() {
        assertFalse("no announcements found at ${folder.absolutePath}", files().isEmpty())
    }

    /**
     * Decoded one by one, so a broken file is named — [AnnouncementCatalog.load]
     * skips what it cannot read, which is right on a phone and wrong here.
     */
    @Test
    fun `every file decodes and carries both languages in full`() {
        val ids = mutableSetOf<String>()
        for (file in files()) {
            val name = file.name
            val item = try {
                AnnouncementCatalog.decode(file.readText())
            } catch (e: Exception) {
                fail("$name: does not decode: ${e.message}")
                return
            }

            assertFalse("$name: empty id", item.id.isEmpty())
            assertTrue("$name: duplicate id ${item.id}", ids.add(item.id))
            assertEquals("$name: the file should be named after its id", "${item.id}.json", name)

            listOfNotNull(item.ships.ios, item.ships.android, item.ships.desktop).forEach { version ->
                assertNotNull("$name: unreadable version $version", AppVersion.parse(version))
            }
            item.audience?.let { audience ->
                assertNotEquals(
                    "$name: audience ${audience.rawValue} is not one the apps know",
                    AnnouncementAudience.Unknown(audience.rawValue),
                    audience,
                )
            }

            for (locale in listOf(Announcement.TRADITIONAL_CHINESE, Announcement.ENGLISH)) {
                val copy = item.copy[locale]
                if (copy == null) {
                    fail("$name: no $locale copy")
                    return
                }
                copy.fields.forEach { field ->
                    assertFalse("$name: an empty $locale field", field.isBlank())
                }
            }
        }
        assertEquals(
            "the loader skipped a file the checks above accepted",
            files().size,
            AnnouncementCatalog.load(files().associate { it.name to it.readText() }).size,
        )
    }

    /**
     * App Store Connect's What's New field rejects Bopomofo with a 409, and this
     * copy is kept in step with the release notes — so a 注音 character here is
     * a release-day failure waiting to happen.
     */
    @Test
    fun `no copy contains bopomofo`() {
        for (file in files()) {
            val item = AnnouncementCatalog.decode(file.readText())
            for ((locale, copy) in item.copy) {
                for (field in copy.fields) {
                    val offending = bopomofoIn(field)
                    assertTrue(
                        "${file.name} [$locale]: Bopomofo $offending in \"$field\"",
                        offending.isEmpty(),
                    )
                }
            }
        }
    }

    /** The check above is only worth something if it can fail. */
    @Test
    fun `the bopomofo ranges catch zhuyin`() {
        assertEquals(4, bopomofoIn("ㄅㄆㄇ ㆠ").length)
    }

    private fun bopomofoIn(text: String): String {
        val ranges = listOf(0x3100..0x312F, 0x31A0..0x31BF)
        return text.codePoints().toArray()
            .filter { point -> ranges.any { point in it } }
            .joinToString("") { String(Character.toChars(it)) }
    }
}
