package com.pathors.parley.ime

import com.pathors.parley.kit.SegmentBuilder
import com.pathors.parley.kit.TranscriptSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the input connection is shown, given what the relay sends.
 *
 * The rule that matters: the relay **re-emits a committed run under the same id
 * as it grows**, so this is an upsert. Treat it as an append and every dictation
 * duplicates itself — which is the failure mode that made iOS give up on
 * streaming its text into the document at all.
 */
class DictationTranscriptTest {

    private companion object {
        /** A settled run the relay has committed. */
        const val SETTLED = "We should ship it"
        /** The tentative tail still being recognised. */
        const val TAIL = " tomorrow"
    }

    private fun committed(id: String, text: String) = TranscriptSegment(
        id = id,
        source = "mix",
        speaker = 0,
        text = text,
        isFinal = true,
        startMs = 0,
        endMs = 0,
    )

    private fun tail(text: String) = TranscriptSegment(
        id = "mix-tail",
        source = "mix",
        speaker = 0,
        text = text,
        isFinal = false,
        startMs = 0,
        endMs = 0,
    )

    @Test
    fun `a fresh transcript is empty`() {
        val transcript = DictationTranscript()
        assertEquals("", transcript.live)
        assertEquals("", transcript.committed)
        assertTrue(transcript.isEmpty)
    }

    @Test
    fun `the tail is shown after the committed runs`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.accept(tail(TAIL))

        assertEquals("$SETTLED$TAIL", transcript.live)
        assertEquals("only the settled run is committed", SETTLED, transcript.committed)
        assertFalse(transcript.isEmpty)
    }

    /** The whole point of keying by id. */
    @Test
    fun `a growing run replaces itself instead of appending`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", "We should"))
        transcript.accept(committed("mix-0", "We should ship"))
        transcript.accept(committed("mix-0", SETTLED))

        assertEquals(SETTLED, transcript.live)
    }

    /**
     * Settled is not final: the relay revises runs it has already emitted, and a
     * revision must overwrite rather than accumulate. On iOS this was unfixable
     * in the document (`insertText` cannot be retracted); here it is one
     * `setComposingText` away.
     */
    @Test
    fun `a revised run overwrites the words it replaces`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", "we should shit it tomorrow"))
        transcript.accept(committed("mix-0", "we should ship it tomorrow"))

        assertEquals("we should ship it tomorrow", transcript.live)
    }

    @Test
    fun `runs keep arrival order`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", "First. "))
        transcript.accept(committed("mix-1", "Second. "))
        transcript.accept(committed("mix-2", "Third."))
        // A late revision of the first run must not move it to the end.
        transcript.accept(committed("mix-0", "First! "))

        assertEquals("First! Second. Third.", transcript.live)
    }

    @Test
    fun `an empty tail clears the previous one`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.accept(tail(" tomo"))
        transcript.accept(tail(""))

        assertEquals(SETTLED, transcript.live)
        assertEquals("", transcript.partial)
    }

    // ── folding ──────────────────────────────────────────────────────────────

    /**
     * The last words spoken before the key was tapped arrive as the tail and
     * would otherwise be dropped when it is cleared.
     */
    @Test
    fun `folding the tail settles it`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.accept(tail(TAIL))
        transcript.foldPartial()

        assertEquals("$SETTLED$TAIL", transcript.committed)
        assertEquals("", transcript.partial)
        assertEquals("$SETTLED$TAIL", transcript.live)
    }

    /**
     * A fold has to become a run rather than an append, because `committed` is
     * derived from the runs on every read — an append would be silently undone by
     * the next segment to arrive.
     */
    @Test
    fun `a folded tail survives a later revision of an earlier run`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.accept(tail(TAIL))
        transcript.foldPartial()
        transcript.accept(committed("mix-0", "We should ship this"))

        assertEquals("We should ship this tomorrow", transcript.committed)
    }

    @Test
    fun `folding nothing changes nothing`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.foldPartial()
        transcript.foldPartial()

        assertEquals(SETTLED, transcript.committed)
    }

    @Test
    fun `two folds do not overwrite each other`() {
        // What a reconnect would produce, and what a fixed fold id would lose.
        val transcript = DictationTranscript()
        transcript.accept(tail("first part "))
        transcript.foldPartial()
        transcript.accept(tail("second part"))
        transcript.foldPartial()

        assertEquals("first part second part", transcript.committed)
    }

    @Test
    fun `a fold id cannot collide with a relay id`() {
        val transcript = DictationTranscript()
        transcript.accept(tail("spoken"))
        transcript.foldPartial()
        // The relay restarts its numbering at 0 on a new leg; a fold must not be
        // in its way.
        transcript.accept(committed("mix-0", " and settled"))

        assertEquals("spoken and settled", transcript.committed)
    }

    @Test
    fun `reset forgets everything`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", SETTLED))
        transcript.accept(tail(TAIL))
        transcript.reset()

        assertEquals("", transcript.live)
        assertTrue(transcript.isEmpty)
    }

    @Test
    fun `whitespace alone still counts as empty`() {
        val transcript = DictationTranscript()
        transcript.accept(committed("mix-0", "   \n "))
        assertTrue("a silent room must not commit whitespace", transcript.isEmpty)
    }

    // ── against the real producer ────────────────────────────────────────────

    /**
     * Driven by the actual [SegmentBuilder] rather than hand-written segments, so
     * the id shapes this class keys on are the ones the relay really emits — the
     * `-tail` suffix especially, which is the one string both sides agree on.
     */
    @Test
    fun `assembles what SegmentBuilder actually produces`() {
        val transcript = DictationTranscript()
        val builder = SegmentBuilder(source = "mix", sink = transcript::accept)

        builder.pushFinal("We ", speaker = 0, startMs = 0, endMs = 100)
        builder.pushFinal("should ", speaker = 0, startMs = 100, endMs = 200)
        builder.emitCommitted()
        assertEquals("We should ", transcript.live)

        builder.emitTail("shi", speaker = 0, startMs = 200)
        assertEquals("We should shi", transcript.live)

        builder.pushFinal("ship it", speaker = 0, startMs = 200, endMs = 400)
        builder.emitCommitted()
        builder.emitTail("", speaker = 0, startMs = 400)
        assertEquals(SETTLED, transcript.live)

        builder.endpoint()
        builder.pushFinal(" Tomorrow.", speaker = 0, startMs = 400, endMs = 600)
        builder.emitCommitted()

        transcript.foldPartial()
        assertEquals("$SETTLED Tomorrow.", transcript.committed)
    }
}
