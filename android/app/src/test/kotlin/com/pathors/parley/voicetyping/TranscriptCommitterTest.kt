package com.pathors.parley.voicetyping

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The partial/final commit rule — the one place a voice keyboard duplicates or
 * drops words, so every way it can go wrong gets a test.
 *
 * [FakeEditor] models `InputConnection`'s actual semantics rather than just
 * recording calls: `commitText` **replaces the composing region**, which is the
 * behaviour the whole design leans on. [FakeEditor.text] is therefore what the
 * user would really see in the field.
 */
class TranscriptCommitterTest {

    /**
     * A miniature editor with a composing region, faithful to
     * `InputConnection`: committed text is permanent, composing text is replaced
     * wholesale by the next `setComposingText` or `commitText`, and
     * `finishComposingText` turns it into committed text.
     */
    private class FakeEditor : DictationEditor {
        private val builder = StringBuilder()
        private var composing = ""

        /** What the field shows: committed text plus the composing region. */
        val text: String get() = builder.toString() + composing

        /** Only the settled part — what survives a `finishComposingText`. */
        val committed: String get() = builder.toString()

        var commitCalls = 0
            private set

        override fun commitText(text: String) {
            composing = ""
            builder.append(text)
            commitCalls += 1
        }

        override fun setComposingText(text: String) {
            composing = text
        }

        override fun finishComposing() {
            builder.append(composing)
            composing = ""
        }
    }

    @Test
    fun `a tail that later settles is not typed twice`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        // The provider guesses, then settles the same words as a committed run.
        committer.update(settled = "", tail = "hello")
        assertEquals("hello", editor.text)
        committer.update(settled = "hello ", tail = "")
        assertEquals("hello ", editor.text)

        committer.update(settled = "hello ", tail = "wor")
        assertEquals("hello wor", editor.text)
        committer.update(settled = "hello ", tail = "world")
        assertEquals("hello world", editor.text)
        committer.update(settled = "hello world", tail = "")

        assertEquals("hello world", editor.text)
        assertEquals("hello world", editor.committed)
    }

    @Test
    fun `a growing run only commits its delta`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        // SegmentBuilder re-emits the open run under the same id as it grows, so
        // the committer sees the whole run every time and must add only the new
        // part.
        committer.update("The quick", "")
        committer.update("The quick brown", "")
        committer.update("The quick brown fox", "")

        assertEquals("The quick brown fox", editor.text)
        assertEquals(3, editor.commitCalls)
    }

    @Test
    fun `a rewritten tail replaces itself in place`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("", "recognise")
        committer.update("", "recognize")
        committer.update("", "recognizing")

        assertEquals("recognizing", editor.text)
        // Nothing settled yet, so nothing may be committed.
        assertEquals("", editor.committed)
        assertEquals(0, editor.commitCalls)
    }

    @Test
    fun `finish keeps the last tail as real text`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("Ship it", "")
        committer.update("Ship it", " today")
        committer.finish()

        assertEquals("Ship it today", editor.committed)
        assertEquals("Ship it today", editor.text)
    }

    @Test
    fun `finish is idempotent`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("", "one")
        committer.finish()
        committer.finish()

        assertEquals("one", editor.committed)
    }

    /**
     * The session folds its tail into the settled text on the way out
     * ([VoiceTypingSession]'s `foldTail`) while the service also calls
     * [TranscriptCommitter.finish] on the terminal state. The two arrive over
     * separate flows, so both orders happen in practice and neither may duplicate.
     */
    @Test
    fun `fold-then-finish and finish-then-fold agree`() {
        val foldFirst = FakeEditor()
        TranscriptCommitter(foldFirst).apply {
            update("hello ", "world")
            update("hello world", "") // session folded the tail
            finish() // service reacted to the terminal state
        }

        val finishFirst = FakeEditor()
        TranscriptCommitter(finishFirst).apply {
            update("hello ", "world")
            finish() // terminal state observed before the final text update
            update("hello world", "")
        }

        assertEquals("hello world", foldFirst.committed)
        assertEquals("hello world", finishFirst.committed)
    }

    @Test
    fun `an empty tail clears the composing region`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("", "maybe")
        committer.update("", "")

        assertEquals("", editor.text)
    }

    @Test
    fun `reset drops an unsettled tail and starts a new session clean`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("done. ", "abandoned")
        committer.reset()
        assertEquals("done. ", editor.text)

        // The new session's own settled text starts from scratch and must not be
        // measured against the previous session's high-water mark.
        committer.update("done. ", "")
        assertEquals("done. done. ", editor.text)
    }

    @Test
    fun `hasComposingText tracks the composing region`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        assertEquals(false, committer.hasComposingText)
        committer.update("", "tentative")
        assertEquals(true, committer.hasComposingText)
        committer.update("tentative", "")
        assertEquals(false, committer.hasComposingText)
    }

    /**
     * Defensive: settled text is only ever appended to in practice (see
     * `SegmentBuilder`), but a provider that rewrote history must not make the
     * keyboard re-type the transcript or splice a garbled suffix into it. It
     * resyncs instead, and later growth still lands correctly.
     */
    @Test
    fun `a rewritten prefix resyncs instead of splicing`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("colour ", "")
        committer.update("color theory ", "")
        assertEquals("colour ", editor.text)
        assertEquals(1, editor.commitCalls)

        committer.update("color theory works", "")
        assertEquals("colour works", editor.text)
    }

    @Test
    fun `a shrinking settled string commits nothing`() {
        val editor = FakeEditor()
        val committer = TranscriptCommitter(editor)

        committer.update("a long sentence", "")
        committer.update("a long", "")

        assertEquals("a long sentence", editor.text)
        assertEquals(1, editor.commitCalls)
    }
}
