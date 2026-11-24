package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The split rule has to agree across iOS, Android and the desktop: the same file
 * must be cut into the same parts with the same titles wherever it is imported.
 */
class ImportSplitTest {

    private val hour = 3_600_000L
    private val maxPart = (5 * 3600 + 50 * 60) * 1000L

    @Test
    fun `the ceiling is five hours fifty minutes`() {
        assertEquals(21_000L, ImportSplit.HOSTED_MAX_PART_SECONDS)
        assertEquals(maxPart, ImportSplit.HOSTED_MAX_PART_MS)
    }

    @Test
    fun `exactly five hours fifty is one part and is not split`() {
        assertEquals(1, ImportSplit.partCount(maxPart))
        assertNull(ImportSplit.plan(maxPart))
    }

    @Test
    fun `one second over is two equal parts`() {
        val duration = maxPart + 1_000
        assertEquals(2, ImportSplit.partCount(duration))
        val plan = checkNotNull(ImportSplit.plan(duration))
        assertEquals(2, plan.count)
        assertEquals(listOf(0L, duration / 2), plan.parts.map { it.startMs })
        assertEquals(listOf(duration / 2, duration), plan.parts.map { it.endMs })
        assertTrue(plan.parts.all { it.durationMs <= maxPart })
    }

    @Test
    fun `thirteen hours is three parts of four hours twenty`() {
        val duration = 13 * hour
        assertEquals(3, ImportSplit.partCount(duration))
        val plan = checkNotNull(ImportSplit.plan(duration))
        assertEquals(3, plan.count)
        val partMs = (4 * 60 + 20) * 60_000L
        assertEquals(partMs, plan.partDurationMs)
        assertEquals(listOf(0L, partMs, 2 * partMs), plan.parts.map { it.startMs })
        assertEquals(listOf(partMs, 2 * partMs, duration), plan.parts.map { it.endMs })
        assertEquals(listOf(1, 2, 3), plan.parts.map { it.index })
        assertEquals(listOf(false, false, true), plan.parts.map { it.isLast })
    }

    @Test
    fun `an unknown length is never split`() {
        assertNull(ImportSplit.partCount(-1))
        assertNull(ImportSplit.plan(-1))
    }

    @Test
    fun `short files and an empty one are a single part`() {
        assertEquals(1, ImportSplit.partCount(0))
        assertEquals(1, ImportSplit.partCount(hour))
        assertNull(ImportSplit.plan(hour))
    }

    @Test
    fun `parts are contiguous, cover the file and differ by at most a millisecond`() {
        for (duration in listOf(maxPart + 1, 2 * maxPart + 7, 40 * hour + 3, 17 * hour + 999)) {
            val parts = checkNotNull(ImportSplit.plan(duration)).parts
            assertEquals(0L, parts.first().startMs)
            assertEquals(duration, parts.last().endMs)
            parts.zipWithNext { a, b -> assertEquals(a.endMs, b.startMs) }
            val lengths = parts.map { it.durationMs }
            assertTrue("$duration: $lengths", lengths.max() - lengths.min() <= 1)
            assertTrue("$duration: $lengths", lengths.all { it <= maxPart })
        }
    }

    @Test
    fun `part titles bracket the index the way each language does`() {
        assertEquals(
            "董事會.m4a（2/3）",
            ImportSplit.partTitle("董事會.m4a", 2, 3, PartTitleStyle.FULL_WIDTH),
        )
        assertEquals(
            "Board meeting (1/2)",
            ImportSplit.partTitle("Board meeting", 1, 2, PartTitleStyle.ASCII),
        )
    }
}
