package com.pathors.parley.kit

import com.pathors.parley.kit.BriefMarkup.Run
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS `BriefMarkupTests` and `TranscriptAnchorTests`, case for case. */
class BriefMarkupTest {

    private fun text(value: String, bold: Boolean = false) = Run.Text(value, bold)

    @Test
    fun `bold and timestamps become runs`() {
        val paragraphs = BriefMarkup.paragraphs("**Progress:** accepted at 22k [1:34], demo next week [1:48].")
        assertEquals(1, paragraphs.size)
        assertEquals(
            listOf(
                text("Progress:", bold = true),
                text(" accepted at 22k "),
                Run.Timestamp(94_000, "1:34"),
                text(", demo next week "),
                Run.Timestamp(108_000, "1:48"),
                text("."),
            ),
            paragraphs[0],
        )
    }

    @Test
    fun `blank lines separate paragraphs and single newlines stay`() {
        assertEquals(
            listOf(listOf(text("one\ntwo")), listOf(text("three"))),
            BriefMarkup.paragraphs("one\ntwo\n\n\nthree"),
        )
    }

    @Test
    fun `windows line endings read the same`() {
        assertEquals(
            listOf(listOf(text("one")), listOf(text("two"))),
            BriefMarkup.paragraphs("one\r\n\r\ntwo"),
        )
    }

    @Test
    fun `brackets that are not clocks stay text`() {
        assertEquals(
            listOf(listOf(text("see [note] and [1:5] and "), Run.Timestamp(3_660_000, "61:00"))),
            BriefMarkup.paragraphs("see [note] and [1:5] and [61:00]"),
        )
    }

    @Test
    fun `an unclosed bold marker is literal`() {
        assertEquals(listOf(listOf(text("2 ** 3"))), BriefMarkup.paragraphs("2 ** 3"))
    }

    @Test
    fun `headings and bullets`() {
        assertEquals(
            listOf(
                listOf(
                    text("Risks", bold = true),
                    text("\n• price "),
                    Run.Timestamp(43_000, "0:43"),
                ),
            ),
            BriefMarkup.paragraphs("## Risks\n- price [0:43]"),
        )
    }

    @Test
    fun `a hash without a space is not a heading`() {
        assertEquals(listOf(listOf(text("#1 priority"))), BriefMarkup.paragraphs("#1 priority"))
    }

    @Test
    fun `an empty brief has no paragraphs`() {
        assertTrue(BriefMarkup.paragraphs("").isEmpty())
        assertTrue(BriefMarkup.paragraphs("  \n\t\n").isEmpty())
    }

    @Test
    fun `clock parsing`() {
        assertEquals(8_000L, BriefMarkup.milliseconds("0:08"))
        assertEquals(3_723_000L, BriefMarkup.milliseconds("1:02:03"))
        assertNull(BriefMarkup.milliseconds("1:60"))
        assertNull(BriefMarkup.milliseconds("abc"))
        assertNull(BriefMarkup.milliseconds("12"))
        assertNull(BriefMarkup.milliseconds("1:2:3:4"))
        assertNull(BriefMarkup.milliseconds("-1:00"))
    }

    // ── TranscriptAnchor ─────────────────────────────────────────────────────

    private fun seg(id: String, start: Long) = TranscriptSegment(
        id = id,
        source = "mix",
        speaker = 1,
        text = id,
        isFinal = true,
        startMs = start,
        endMs = start + 1_000,
    )

    @Test
    fun `a floored clock lands on the turn it names`() {
        val segments = listOf(seg("a", 300), seg("b", 8_900), seg("c", 18_076))
        // The brief says [0:08] for the turn that starts at 8.9 s.
        assertEquals("b", TranscriptAnchor.turn(8_000, segments)?.id)
        assertEquals(8_900L, TranscriptAnchor.seekMs(8_000, segments.map { it.startMs }))
    }

    @Test
    fun `a moment inside a turn stays there`() {
        val segments = listOf(seg("a", 300), seg("b", 8_900), seg("c", 18_076))
        assertEquals("b", TranscriptAnchor.turn(12_000, segments)?.id)
        assertEquals(12_000L, TranscriptAnchor.seekMs(12_000, segments.map { it.startMs }))
    }

    @Test
    fun `before everything is the first turn and nothing is nil`() {
        assertEquals("a", TranscriptAnchor.turn(0, listOf(seg("a", 5_000)))?.id)
        assertNull(TranscriptAnchor.turn(0, emptyList()))
        assertEquals(-1, TranscriptAnchor.turnIndex(0, emptyList()))
        assertEquals(1_234L, TranscriptAnchor.seekMs(1_234, emptyList()))
    }

    /**
     * The shipped sample's brief links into its own recording — every
     * timestamp it writes resolves to a turn.
     */
    @Test
    fun `the shipped briefs link into their recordings`() {
        for (lang in listOf("en", "zh-TW")) {
            val file = java.io.File("../../public/sample/sample.$lang.json")
            if (!file.isFile) continue
            val manifest = SampleManifest.decode(file.readText())
            val stamps = BriefMarkup.paragraphs(manifest.brief.orEmpty())
                .flatten()
                .filterIsInstance<Run.Timestamp>()
            assertFalse("$lang brief has no timestamps", stamps.isEmpty())
            val starts = manifest.transcriptSegments.map { it.startMs }
            for (stamp in stamps) {
                assertTrue(stamp.ms <= manifest.durationMs)
                assertTrue(TranscriptAnchor.turnIndex(stamp.ms, starts) >= 0)
            }
        }
    }
}
