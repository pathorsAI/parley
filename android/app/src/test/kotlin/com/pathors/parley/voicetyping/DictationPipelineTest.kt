package com.pathors.parley.voicetyping

import com.pathors.parley.kit.SonioxStreamParser
import com.pathors.parley.kit.TranscriptSegment
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The whole text path, end to end, with no microphone and no socket: real relay
 * frames → the real [SonioxStreamParser] and `SegmentBuilder` → the real
 * [DictationTextAssembler] → the real [TranscriptCommitter] → a fake editor with
 * `InputConnection`'s composing-region semantics.
 *
 * This is the test that would catch the bug the feature is most likely to have:
 * a word that is spoken once and typed twice, because the provider first sent it
 * as a non-final token and then again inside a final one. [VoiceTypingSession]
 * itself is the only piece left out, and the only thing it adds is the coroutine
 * wiring between these parts.
 */
class DictationPipelineTest {

    /** Same faithful stand-in as in [TranscriptCommitterTest]. */
    private class FakeEditor : DictationEditor {
        private val builder = StringBuilder()
        private var composing = ""

        val text: String get() = builder.toString() + composing
        val committed: String get() = builder.toString()

        override fun commitText(text: String) {
            composing = ""
            builder.append(text)
        }

        override fun setComposingText(text: String) {
            composing = text
        }

        override fun finishComposing() {
            builder.append(composing)
            composing = ""
        }
    }

    /** Drives the production pipeline, one socket frame at a time. */
    private class Pipeline {
        val editor = FakeEditor()
        private val committer = TranscriptCommitter(editor)
        private val assembler = DictationTextAssembler()
        private val parser = SonioxStreamParser(SOURCE, ::onSegment)

        private fun onSegment(segment: TranscriptSegment) {
            val text = assembler.accept(segment)
            committer.update(text.settled, text.tail)
        }

        fun frame(json: String) = parser.process(json)

        /** What the session and the service do when the stream ends. */
        fun finish() {
            val text = assembler.foldTail()
            committer.update(text.settled, text.tail)
            committer.finish()
        }
    }

    private fun tokens(vararg tokens: String) =
        """{"tokens":[${tokens.joinToString(",")}]}"""

    private fun token(text: String, isFinal: Boolean, start: Long = 0, end: Long = 0) =
        """{"text":"$text","is_final":$isFinal,"start_ms":$start,"end_ms":$end,"speaker":"1"}"""

    private fun endpoint() = """{"tokens":[{"text":"<end>","is_final":true}]}"""

    @Test
    fun `a word guessed then finalized is typed once`() {
        val pipeline = Pipeline()

        // Frame 1: the provider is guessing.
        pipeline.frame(tokens(token("Hello", isFinal = false)))
        assertEquals("Hello", pipeline.editor.text)
        assertEquals("", pipeline.editor.committed)

        // Frame 2: the same word comes back settled, with a new guess behind it.
        pipeline.frame(
            tokens(
                token("Hello", isFinal = true, end = 400),
                token(" wor", isFinal = false, start = 400),
            )
        )
        assertEquals("Hello wor", pipeline.editor.text)
        assertEquals("Hello", pipeline.editor.committed)

        // Frame 3: the rest settles.
        pipeline.frame(tokens(token(" world", isFinal = true, start = 400, end = 900)))
        assertEquals("Hello world", pipeline.editor.text)
        assertEquals("Hello world", pipeline.editor.committed)
    }

    @Test
    fun `an endpoint closes the run and the next utterance appends`() {
        val pipeline = Pipeline()

        pipeline.frame(tokens(token("First sentence.", isFinal = true, end = 900)))
        pipeline.frame(endpoint())
        // The endpoint advances SegmentBuilder's segment id, so the next
        // utterance arrives as a *different* run — the assembler must join them
        // rather than replace one with the other.
        pipeline.frame(tokens(token(" Second sentence.", isFinal = true, start = 1000, end = 1800)))

        assertEquals("First sentence. Second sentence.", pipeline.editor.committed)
    }

    @Test
    fun `the last guess survives the end of the stream`() {
        val pipeline = Pipeline()

        pipeline.frame(tokens(token("Ship it", isFinal = true, end = 500)))
        pipeline.frame(tokens(token(" today", isFinal = false, start = 500)))
        // The user stops before the provider settles the tail.
        pipeline.finish()

        assertEquals("Ship it today", pipeline.editor.committed)
    }

    @Test
    fun `a speaker change does not duplicate the earlier run`() {
        val pipeline = Pipeline()

        pipeline.frame(
            tokens("""{"text":"one ","is_final":true,"start_ms":0,"end_ms":100,"speaker":"1"}""")
        )
        // SegmentBuilder closes the open run on a speaker change and starts a new
        // one; both stay in the transcript, in order.
        pipeline.frame(
            tokens("""{"text":"two","is_final":true,"start_ms":100,"end_ms":200,"speaker":"2"}""")
        )
        pipeline.finish()

        assertEquals("one two", pipeline.editor.committed)
    }

    @Test
    fun `a guess that the provider withdraws leaves nothing behind`() {
        val pipeline = Pipeline()

        pipeline.frame(tokens(token("umm", isFinal = false)))
        assertEquals("umm", pipeline.editor.text)
        // Next frame has no non-final tokens at all: the tail is cleared.
        pipeline.frame(tokens(token("Right", isFinal = true, end = 300)))
        pipeline.finish()

        assertEquals("Right", pipeline.editor.committed)
    }

    @Test
    fun `many rewrites of the same guess commit nothing`() {
        val pipeline = Pipeline()

        pipeline.frame(tokens(token("re", isFinal = false)))
        pipeline.frame(tokens(token("reco", isFinal = false)))
        pipeline.frame(tokens(token("recogni", isFinal = false)))
        pipeline.frame(tokens(token("recognise", isFinal = false)))

        assertEquals("recognise", pipeline.editor.text)
        assertEquals("", pipeline.editor.committed)
    }

    private companion object {
        /** A phone has one mic, so the relay's source is always `mix`. */
        const val SOURCE = "mix"
    }
}
