package com.pathors.parley.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The two string files have to hold the same keys.
 *
 * `values/strings.xml` says so at the top of itself — "a string that exists in
 * only one of the two files is a bug" — but nothing enforced it. Android's own
 * tooling will not: a missing translation falls back to English silently, so the
 * failure ships, and the way it is noticed is a Chinese screen with an English
 * sentence in the middle of it. Placeholders are checked too, because a
 * `%1$s`/`%2$d` mismatch between locales is not a fallback but a crash inside
 * `String.format` on whichever locale got it wrong.
 */
class StringsParityTest {

    @Test
    fun `both locales declare the same keys`() {
        val english = keysOf(stringsFile("values"))
        val chinese = keysOf(stringsFile("values-zh-rTW"))

        assertTrue("values/strings.xml parsed as empty", english.isNotEmpty())
        assertEquals(
            "keys missing from values-zh-rTW/strings.xml",
            emptySet<String>(),
            english - chinese,
        )
        assertEquals(
            "keys missing from values/strings.xml",
            emptySet<String>(),
            chinese - english,
        )
    }

    @Test
    fun `both locales use the same placeholders`() {
        val english = placeholdersOf(stringsFile("values"))
        val chinese = placeholdersOf(stringsFile("values-zh-rTW"))

        val mismatched = english.keys
            .intersect(chinese.keys)
            .filter { english[it] != chinese[it] }
            .map { "$it: ${english[it]} vs ${chinese[it]}" }

        assertEquals("placeholders differ between locales", emptyList<String>(), mismatched)
    }

    /**
     * Unit tests run with the module directory as the working directory, which is
     * what makes a relative path here reliable — and the assertion below turns a
     * change in that assumption into a clear failure rather than an empty set
     * silently passing both tests above.
     */
    private fun stringsFile(qualifier: String): File {
        val file = File("src/main/res/$qualifier/strings.xml")
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        return file
    }

    /** Every `<string>`/`<plurals>` name, plurals counted once. */
    private fun keysOf(file: File): Set<String> =
        elementsOf(file).map { it.getAttribute("name") }.toSet()

    /** Key to the set of `%n$x` placeholders its text uses, across all plural items. */
    private fun placeholdersOf(file: File): Map<String, Set<String>> =
        elementsOf(file).associate { element ->
            element.getAttribute("name") to PLACEHOLDER
                .findAll(element.textContent.orEmpty())
                .map { it.value }
                .toSet()
        }

    private fun elementsOf(file: File): List<Element> {
        val document = DocumentBuilderFactory.newInstance()
            .newDocumentBuilder()
            .parse(file)
        return listOf("string", "plurals").flatMap { tag ->
            val nodes = document.getElementsByTagName(tag)
            (0 until nodes.length).map { nodes.item(it) as Element }
        }
    }

    private companion object {
        val PLACEHOLDER = Regex("""%\d+\$[a-zA-Z]""")
    }
}
