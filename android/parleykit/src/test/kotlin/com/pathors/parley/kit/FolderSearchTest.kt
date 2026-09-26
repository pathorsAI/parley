package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the folder picker's search field promises. Ported from iOS
 * `ParleyKitTests/FolderSearchTests.swift`, case for case, so the two phones
 * find the same folder for the same typing.
 */
class FolderSearchTest {

    private data class Folder(val id: String, val name: String)

    private val folders = listOf("Acme Corp", "Café Luna", "北風工業", "Northwind", "晴光實驗室")
        .map { Folder(id = it, name = it) }

    private fun names(query: String) = FolderSearch.filter(folders, query) { it.name }.map { it.name }

    @Test
    fun `an empty query is the whole list`() {
        assertEquals(folders.size, names("").size)
        assertEquals(folders.size, names("   ").size)
    }

    @Test
    fun `matches a substring anywhere in the name`() {
        assertEquals(listOf("Acme Corp"), names("corp"))
        assertEquals(listOf("Northwind"), names("wind"))
    }

    @Test
    fun `ignores case`() {
        assertEquals(listOf("Acme Corp"), names("ACME"))
    }

    @Test
    fun `ignores diacritics`() {
        assertEquals(listOf("Café Luna"), names("cafe"))
    }

    /** A zh-Hant keyboard can type full-width Latin; it must still find the folder. */
    @Test
    fun `ignores full-width Latin`() {
        assertEquals(listOf("Acme Corp"), names("ＡＣＭＥ"))
    }

    @Test
    fun `matches Chinese without spaces`() {
        assertEquals(listOf("北風工業"), names("北風"))
        assertEquals(listOf("晴光實驗室"), names("實驗"))
    }

    @Test
    fun `trims the query`() {
        assertEquals(listOf("Café Luna"), names("  luna "))
    }

    /** Ideographic space is what a zh-Hant keyboard's space bar types. */
    @Test
    fun `trims an ideographic space too`() {
        assertEquals(listOf("北風工業"), names("　北風　"))
    }

    @Test
    fun `no match is empty`() {
        assertTrue(names("Halcyon").isEmpty())
    }

    @Test
    fun `keeps the server's order`() {
        assertEquals(listOf("Acme Corp", "Café Luna"), names("a"))
    }

    @Test
    fun `an exact match is loose too`() {
        assertTrue(FolderSearch.hasExactMatch(folders, "acme corp") { it.name })
        assertTrue(FolderSearch.hasExactMatch(folders, " cafe luna ") { it.name })
        assertFalse(FolderSearch.hasExactMatch(folders, "acme") { it.name })
        assertFalse(FolderSearch.hasExactMatch(folders, "") { it.name })
    }

    @Test
    fun `the exact match is the folder itself`() {
        assertEquals("Northwind", FolderSearch.exactMatch(folders, "NORTHWIND") { it.name }?.id)
        assertNull(FolderSearch.exactMatch(folders, "North") { it.name })
    }

    /** "Unfiled" is matched by the same rules, so it answers to its own name. */
    @Test
    fun `matches works on a single label`() {
        assertTrue(FolderSearch.matches("Unfiled", "unf"))
        assertTrue(FolderSearch.matches("未歸檔", "歸檔"))
        assertTrue(FolderSearch.matches("Unfiled", ""))
        assertFalse(FolderSearch.matches("Unfiled", "Acme"))
    }
}
