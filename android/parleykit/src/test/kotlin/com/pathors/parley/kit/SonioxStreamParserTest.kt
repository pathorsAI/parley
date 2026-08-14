package com.pathors.parley.kit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Read-loop semantics from `soniox.rs::run_session` (via
 * `SonioxStreamParserTests.swift`), driven with realistic Soniox relay frames
 * (the relay is a byte-for-byte passthrough downstream).
 */
class SonioxStreamParserTest {
    private val emitted = mutableListOf<TranscriptSegment>()
    private lateinit var parser: SonioxStreamParser

    @Before
    fun setUp() {
        emitted.clear()
        parser = SonioxStreamParser("mix") { emitted.add(it) }
    }

    @Test
    fun finalAndInterimTokensInOneFrame() {
        parser.process(
            """
            {"tokens":[
              {"text":"你好","is_final":true,"start_ms":0,"end_ms":300,"speaker":"1"},
              {"text":"，請","is_final":true,"start_ms":300,"end_ms":500,"speaker":"1"},
              {"text":"問","is_final":false,"start_ms":500,"end_ms":600,"speaker":"1"}
            ],"finished":false}
            """
        )

        // emit_committed (solid run) + emit_tail (interim)
        assertEquals(2, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals("你好，請", emitted[0].text)
        assertTrue(emitted[0].isFinal)
        assertEquals("mix-tail", emitted[1].id)
        assertEquals("問", emitted[1].text)
        assertFalse(emitted[1].isFinal)
        assertEquals(1, emitted[1].speaker)
    }

    @Test
    fun endTokenDrivesEndpoint() {
        parser.process(
            """
            {"tokens":[
              {"text":"Deal.","is_final":true,"start_ms":0,"end_ms":400,"speaker":"2"},
              {"text":"<end>","is_final":true}
            ]}
            """
        )
        parser.process(
            """
            {"tokens":[{"text":"Next.","is_final":true,"start_ms":900,"end_ms":1200,"speaker":"2"}]}
            """
        )

        // Frame 1: committed run (emit_committed), cleared tail, endpoint commit
        // reuses the same id (mix-0) — matching Rust where emit_committed and the
        // endpoint commit both fire at index 0, then the index advances.
        val finals = emitted.filter { it.isFinal }
        assertEquals("mix-0", finals[0].id)
        assertEquals("Deal.", finals[0].text)
        // Frame 2 opens a fresh run under the advanced id.
        assertEquals("mix-1", finals.last().id)
        assertEquals("Next.", finals.last().text)
    }

    @Test
    fun missingSpeakerParsesAsZero() {
        parser.process("""{"tokens":[{"text":"hello","is_final":true,"start_ms":0,"end_ms":200}]}""")
        assertEquals(0, emitted.first().speaker)
    }

    @Test
    fun errorFrameThrows() {
        val error =
            assertThrows(SonioxStreamError::class.java) {
                parser.process("""{"error_code":402,"error_message":"quota_exhausted"}""")
            }
        assertEquals(SonioxStreamError(402, "quota_exhausted"), error)
    }

    @Test
    fun finishedMarkerSetsFlag() {
        parser.process("""{"tokens":[{"text":"<fin>","is_final":true}],"finished":true}""")
        assertTrue(parser.finished)
    }

    @Test
    fun unparseableFrameIsSkipped() {
        parser.process("not json at all")
        assertTrue(emitted.isEmpty())
    }

    @Test
    fun emptyTailClearsAfterFinalization() {
        parser.process(
            """{"tokens":[{"text":"draft","is_final":false,"start_ms":0,"end_ms":100,"speaker":"1"}]}"""
        )
        parser.process(
            """{"tokens":[{"text":"drafted","is_final":true,"start_ms":0,"end_ms":150,"speaker":"1"}]}"""
        )

        // Frame 1: tail only. Frame 2: solid run + empty tail (clears the row).
        assertEquals("mix-tail", emitted[0].id)
        assertEquals("draft", emitted[0].text)
        val last = emitted.last()
        assertEquals("mix-tail", last.id)
        assertEquals("tail cleared once text finalized", "", last.text)
    }

    @Test
    fun pcmLittleEndianEncoding() {
        val data = SonioxProtocol.pcmToLeBytes(shortArrayOf(0x0102, -2))
        assertArrayEquals(
            byteArrayOf(0x02, 0x01, 0xFE.toByte(), 0xFF.toByte()),
            data,
        )
    }

    @Test
    fun configFrameOmitsApiKeyInRelayMode() {
        val config =
            SonioxProtocol.Config(
                apiKey = null,
                model = "stt-rt-v5",
                languageHints = listOf("zh", "en"),
            )
        val json = SonioxProtocol.encodeConfig(config)
        assertFalse("relay mode must not send a vendor key field", json.contains("api_key"))
        assertTrue(json.contains("\"audio_format\":\"pcm_s16le\""))
        assertTrue(json.contains("\"sample_rate\":16000"))
        assertTrue(json.contains("\"enable_speaker_diarization\":true"))
        assertTrue(json.contains("\"language_hints\":[\"zh\",\"en\"]"))
    }

    @Test
    fun configFrameKeepsApiKeyInByokMode() {
        // The relay never sees this path, but the encoder must still be able to
        // speak plain Soniox — the Rust `skip_serializing_if` only drops null.
        val json = SonioxProtocol.encodeConfig(SonioxProtocol.Config(apiKey = "k", model = "m"))
        assertTrue(json.contains("\"api_key\":\"k\""))
    }
}
