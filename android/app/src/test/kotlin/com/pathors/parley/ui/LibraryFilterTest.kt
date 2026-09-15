package com.pathors.parley.ui

import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the library's search field promises.
 *
 * The field itself is a `TextField` and a list that gets shorter; this is the
 * part that is a contract — which rows survive a query, and what an empty one
 * means. The last matters most: an empty field is the state the library spends
 * almost all of its life in, and a filter that treated it as a query would show
 * a signed-in user nothing at all.
 */
class LibraryFilterTest {

    private fun recording(
        id: String,
        title: String,
        snippet: String? = null,
    ) = RecordingSummary(
        id = id,
        title = title,
        source = RecordingSource.LIVE,
        createdAt = 1_700_000_000_000.0,
        durationMs = 1_122_000.0,
        hasAudio = true,
        snippet = snippet,
    )

    private val library = listOf(
        recording(
            "renewal",
            "Renewal terms — Northwind",
            "Forty seats against an eighty-seat quote; price held to the next renewal.",
        ),
        recording(
            "discovery",
            "Discovery call — Halcyon Labs",
            "Security questionnaire due Friday.",
        ),
        recording("review", "季度檢討 — 子午線", "使用量季增 22%；兩項待辦順延到下一季。"),
        recording("untitled", "", null),
    )

    private fun ids(query: String) =
        HomeViewModel.filterRecordings(library, query).map { it.id }

    @Test
    fun `an empty query is not a query`() {
        assertEquals(library, HomeViewModel.filterRecordings(library, ""))
        assertEquals(library, HomeViewModel.filterRecordings(library, "   "))
    }

    @Test
    fun `matches a title regardless of case`() {
        assertEquals(listOf("discovery"), ids("halcyon"))
        assertEquals(listOf("discovery"), ids("HALCYON"))
    }

    /**
     * The snippet is half the point: a meeting is as often remembered by
     * something said in it as by what it ended up being called.
     */
    @Test
    fun `matches a snippet the title says nothing about`() {
        assertEquals(listOf("discovery"), ids("questionnaire"))
    }

    @Test
    fun `matches Chinese with no word boundaries`() {
        assertEquals(listOf("review"), ids("季度"))
        assertEquals(listOf("review"), ids("待辦"))
    }

    /** Order is the library's own — filtering narrows, it does not re-rank. */
    @Test
    fun `several matches keep their order`() {
        assertEquals(listOf("renewal", "discovery"), ids("e"))
    }

    @Test
    fun `no match is an empty library rather than the whole one`() {
        assertEquals(emptyList<String>(), ids("Okta"))
    }

    /**
     * A row with no snippet at all must not throw or quietly match everything —
     * an untitled recording with nothing transcribed yet is a real row.
     */
    @Test
    fun `a row with no title and no snippet simply never matches`() {
        assertEquals(emptyList<String>(), ids("untitled"))
    }

    @Test
    fun `surrounding whitespace is trimmed`() {
        assertEquals(listOf("discovery"), ids("  halcyon  "))
    }
}
