package com.pathors.parley.kit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The id the parser gives its one tentative segment, for the `"mix"` prefix. */
private const val MIX_TAIL_ID = "mix-tail"

/**
 * Frame encoding and decoding for Parley's stream protocol v2, and how the
 * decoded frames map onto transcript segments.
 */
class ParleyStreamParserTest {
    private val emitted = mutableListOf<TranscriptSegment>()
    private lateinit var parser: ParleyStreamParser

    @Before
    fun setUp() {
        emitted.clear()
        parser = ParleyStreamParser("mix") { emitted.add(it) }
    }

    // ── encoding ────────────────────────────────────────────────────────────

    @Test
    fun startFrameCarriesEverything() {
        val json = ParleyStreamProtocol.encodeStart(
            ParleyStreamProtocol.Start(
                languages = listOf("zh", "en"),
                diarization = true,
                endpointing = true,
                hints = ParleyStreamProtocol.Hints(listOf("Parley", "派斯")),
            )
        )
        assertEquals(
            """{"type":"start","audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},""" +
                """"languages":["zh","en"],"diarization":true,"endpointing":true,""" +
                """"hints":{"terms":["Parley","派斯"]}}""",
            json,
        )
    }

    @Test
    fun startFrameOmitsAbsentOptionalFields() {
        val json = ParleyStreamProtocol.encodeStart(ParleyStreamProtocol.Start())
        assertFalse(json.contains("languages"))
        assertFalse(json.contains("hints"))
        assertTrue(json.contains("\"type\":\"start\""))
        assertTrue(json.contains("\"diarization\":false"))
        assertTrue(json.contains("\"endpointing\":true"))
    }

    @Test
    fun startFrameFromClientOptions() {
        val start = SttRelayClient.startFrame(
            SttRelayClient.Options(bearerToken = "t", languageHints = listOf("zh", "en"))
        )
        assertEquals(listOf("zh", "en"), start.languages)
        assertTrue("the hosted path has always asked for speakers", start.diarization)
        assertTrue(start.endpointing)
        assertNull("no terms, no hints object", start.hints)

        val bare = SttRelayClient.startFrame(
            SttRelayClient.Options(bearerToken = "t", languageHints = emptyList(), hintTerms = listOf("派斯"))
        )
        assertNull("an empty language list means auto-detect", bare.languages)
        assertEquals(listOf("派斯"), bare.hints?.terms)
    }

    @Test
    fun controlFramesAreExact() {
        assertEquals("""{"type":"keepalive"}""", ParleyStreamProtocol.KEEPALIVE_FRAME)
        assertEquals("""{"type":"finalize"}""", ParleyStreamProtocol.FINALIZE_FRAME)
        assertEquals("""{"type":"end"}""", ParleyStreamProtocol.END_FRAME)
    }

    @Test
    fun pcmLittleEndianEncoding() {
        val data = ParleyStreamProtocol.pcmToLeBytes(shortArrayOf(0x0102, -2))
        assertArrayEquals(
            byteArrayOf(0x02, 0x01, 0xFE.toByte(), 0xFF.toByte()),
            data,
        )
    }

    // ── decoding ────────────────────────────────────────────────────────────

    @Test
    fun decodesEveryServerFrame() {
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Ready("s-1"),
            ParleyStreamProtocol.decode("""{"type":"ready","session_id":"s-1"}"""),
        )
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Endpoint,
            ParleyStreamProtocol.decode("""{"type":"endpoint"}"""),
        )
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Finalized,
            ParleyStreamProtocol.decode("""{"type":"finalized"}"""),
        )
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Done,
            ParleyStreamProtocol.decode("""{"type":"done"}"""),
        )
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Error("quota_exceeded", "Quota exhausted."),
            ParleyStreamProtocol.decode("""{"type":"error","code":"quota_exceeded","message":"Quota exhausted."}"""),
        )
    }

    @Test
    fun decodesTranscriptTokensWithOptionalFields() {
        val message = ParleyStreamProtocol.decode(
            """
            {"type":"transcript","final_audio_ms":1234,"total_audio_ms":1500,"tokens":[
              {"text":"你好","start_ms":0,"end_ms":320,"final":true,"speaker":1,"language":"zh","confidence":0.97},
              {"text":" there","start_ms":320,"end_ms":400,"final":false}
            ]}
            """
        ) as ParleyStreamProtocol.ServerMessage.Transcript

        assertEquals(1234L, message.finalAudioMs)
        assertEquals(1500L, message.totalAudioMs)
        assertEquals(
            ParleyStreamProtocol.Token("你好", 0, 320, isFinal = true, speaker = 1, language = "zh", confidence = 0.97),
            message.tokens[0],
        )
        assertEquals(
            ParleyStreamProtocol.Token(" there", 320, 400, isFinal = false),
            message.tokens[1],
        )
    }

    @Test
    fun unknownTypesAndGarbageAreSkipped() {
        assertNull(ParleyStreamProtocol.decode("""{"type":"something_new","x":1}"""))
        assertNull(ParleyStreamProtocol.decode("not json at all"))
        assertNull(parser.process("""{"type":"something_new"}"""))
        assertTrue(emitted.isEmpty())
    }

    @Test
    fun errorWithoutCodeReadsAsInternal() {
        assertEquals(
            ParleyStreamProtocol.ServerMessage.Error("internal", ""),
            ParleyStreamProtocol.decode("""{"type":"error"}"""),
        )
    }

    // ── mapping ─────────────────────────────────────────────────────────────

    @Test
    fun readyMarksTheSessionLive() {
        assertFalse(parser.ready)
        parser.process("""{"type":"ready","session_id":"abc"}""")
        assertTrue(parser.ready)
        assertEquals("abc", parser.sessionId)
        assertTrue(emitted.isEmpty())
    }

    @Test
    fun finalAndInterimTokensInOneFrame() {
        parser.process(
            """
            {"type":"transcript","tokens":[
              {"text":"你好","final":true,"start_ms":0,"end_ms":300,"speaker":1},
              {"text":"，請","final":true,"start_ms":300,"end_ms":500,"speaker":1},
              {"text":"問","final":false,"start_ms":500,"end_ms":600,"speaker":1}
            ]}
            """
        )

        // committed run + tail
        assertEquals(2, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals("你好，請", emitted[0].text)
        assertTrue(emitted[0].isFinal)
        assertEquals(MIX_TAIL_ID, emitted[1].id)
        assertEquals("問", emitted[1].text)
        assertFalse(emitted[1].isFinal)
        assertEquals(1, emitted[1].speaker)
    }

    @Test
    fun endpointFrameClosesTheUtterance() {
        parser.process(
            """{"type":"transcript","tokens":[{"text":"Deal.","final":true,"start_ms":0,"end_ms":400,"speaker":2}]}"""
        )
        parser.process("""{"type":"endpoint"}""")
        parser.process(
            """{"type":"transcript","tokens":[{"text":"Next.","final":true,"start_ms":900,"end_ms":1200,"speaker":2}]}"""
        )

        val finals = emitted.filter { it.isFinal }
        assertEquals("mix-0", finals[0].id)
        assertEquals("Deal.", finals[0].text)
        // The endpoint advanced the id: the next utterance is a new segment.
        assertEquals("mix-1", finals.last().id)
        assertEquals("Next.", finals.last().text)
    }

    @Test
    fun finalizedFrameAlsoClosesTheUtterance() {
        parser.process(
            """{"type":"transcript","tokens":[{"text":"One.","final":true,"start_ms":0,"end_ms":400}]}"""
        )
        parser.process("""{"type":"finalized"}""")
        parser.process(
            """{"type":"transcript","tokens":[{"text":"Two.","final":true,"start_ms":500,"end_ms":900}]}"""
        )
        assertEquals("mix-1", emitted.filter { it.isFinal }.last().id)
    }

    @Test
    fun withoutAnEndpointTheRunKeepsGrowing() {
        parser.process(
            """{"type":"transcript","tokens":[{"text":"One ","final":true,"start_ms":0,"end_ms":400}]}"""
        )
        parser.process(
            """{"type":"transcript","tokens":[{"text":"two.","final":true,"start_ms":400,"end_ms":900}]}"""
        )
        val last = emitted.filter { it.isFinal }.last()
        assertEquals("mix-0", last.id)
        assertEquals("One two.", last.text)
    }

    @Test
    fun missingSpeakerParsesAsZero() {
        parser.process("""{"type":"transcript","tokens":[{"text":"hello","final":true,"start_ms":0,"end_ms":200}]}""")
        assertEquals(0, emitted.first().speaker)
    }

    @Test
    fun doneSetsFinished() {
        assertEquals(ParleyStreamProtocol.ServerMessage.Done, parser.process("""{"type":"done"}"""))
        assertTrue(parser.finished)
    }

    @Test
    fun errorFrameThrows() {
        val error =
            assertThrows(ParleyStreamError::class.java) {
                parser.process("""{"type":"error","code":"upstream_unavailable","message":"Transcription is unavailable."}""")
            }
        assertEquals(ParleyStreamError("upstream_unavailable", "Transcription is unavailable."), error)
    }

    @Test
    fun emptyTailClearsAfterFinalization() {
        parser.process(
            """{"type":"transcript","tokens":[{"text":"draft","final":false,"start_ms":0,"end_ms":100,"speaker":1}]}"""
        )
        parser.process(
            """{"type":"transcript","tokens":[{"text":"drafted","final":true,"start_ms":0,"end_ms":150,"speaker":1}]}"""
        )

        assertEquals(MIX_TAIL_ID, emitted[0].id)
        assertEquals("draft", emitted[0].text)
        val last = emitted.last()
        assertEquals(MIX_TAIL_ID, last.id)
        assertEquals("tail cleared once text finalized", "", last.text)
    }

    @Test
    fun timeOffsetShiftsEverySegment() {
        val shifted = mutableListOf<TranscriptSegment>()
        val legParser = ParleyStreamParser("mix", idPrefix = "mix@1", timeOffsetMs = 2_000) { shifted += it }
        legParser.process(
            """{"type":"transcript","tokens":[{"text":"Hi.","final":true,"start_ms":0,"end_ms":600,"speaker":1}]}"""
        )
        assertEquals("mix@1-0", shifted[0].id)
        assertEquals(2_000L, shifted[0].startMs)
        assertEquals(2_600L, shifted[0].endMs)
    }

    // ── terminal event mapping ──────────────────────────────────────────────

    @Test
    fun quotaErrorMapsToQuotaExceeded() {
        val event = SttRelayClient.errorEvent(ParleyStreamError("quota_exceeded", "Quota exhausted."))
        assertEquals(SttRelayEvent.QuotaExceeded("relay error quota_exceeded: Quota exhausted."), event)
    }

    @Test
    fun otherErrorsMapToErrorWithoutAnHttpStatus() {
        val event = SttRelayClient.errorEvent(ParleyStreamError("idle_timeout", "Idle."))
        assertEquals(SttRelayEvent.Error("relay error idle_timeout: Idle."), event)
        assertFalse((event as SttRelayEvent.Error).isUnauthorized)
    }

    @Test
    fun quotaCloseCodeMapsToQuotaExceeded() {
        assertTrue(SttRelayClient.streamCloseEvent(4402, "") is SttRelayEvent.QuotaExceeded)
        assertEquals(SttRelayEvent.Closed("close code=1000 "), SttRelayClient.streamCloseEvent(1000, ""))
        assertEquals(SttRelayEvent.Closed("close code=1011 x"), SttRelayClient.streamCloseEvent(1011, "x"))
    }

    @Test
    fun streamUrlMovesV1PathToV2AndReplacesTheQuery() {
        assertEquals(
            "https://api.parley.tw/stt/v2/stream?feature=meeting",
            SttRelayClient.streamUrl("wss://api.parley.tw/stt/stream?x=1", "meeting").toString(),
        )
        assertEquals(
            "https://api.parley.tw/stt/v2/stream?feature=voice_typing",
            SttRelayClient.streamUrl(SttRelayClient.DEFAULT_RELAY_URL, "voice_typing").toString(),
        )
        assertEquals(
            "http://localhost:8080/custom?feature=meeting",
            SttRelayClient.streamUrl("ws://localhost:8080/custom", "meeting").toString(),
        )
    }
}
