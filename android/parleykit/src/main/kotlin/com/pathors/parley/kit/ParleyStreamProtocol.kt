package com.pathors.parley.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Parley's hosted streaming transcription protocol, v2
 * (`wss://api.parley.tw/stt/v2/stream`).
 *
 * The protocol belongs to Parley: the client describes the audio and what it
 * wants (languages, diarization, endpointing, hint terms) in one `start` frame,
 * streams raw PCM, and reads back transcript tokens plus a handful of control
 * frames. Which recognizer runs behind the service is a server-side concern and
 * can change without a client release.
 *
 * Client → server:
 * - `start` (first text frame, required before any audio) — [Start]
 * - binary frames: 16 kHz mono s16le PCM
 * - [KEEPALIVE_FRAME] while no audio flows
 * - [FINALIZE_FRAME]: finalize everything so far; audio may continue
 * - [END_FRAME]: no more audio; the server flushes, sends `done` and closes 1000
 *
 * Server → client: see [ServerMessage].
 */
object ParleyStreamProtocol {
    /**
     * Keepalive cadence in milliseconds. The service closes a session that has
     * neither audio nor keepalive for its idle window; the desktop and iOS send
     * this every 2 seconds too.
     */
    const val KEEPALIVE_INTERVAL_MS = 2_000L
    const val KEEPALIVE_FRAME = """{"type":"keepalive"}"""
    const val FINALIZE_FRAME = """{"type":"finalize"}"""
    const val END_FRAME = """{"type":"end"}"""

    /**
     * Everything in the pipeline is 16 kHz mono s16le, matching the desktop's
     * `TARGET_SAMPLE_RATE` and the service's metering (32 000 bytes/second).
     * It is also the only audio format the service accepts today.
     */
    const val SAMPLE_RATE = 16_000
    const val AUDIO_ENCODING = "pcm_s16le"
    const val CHANNELS = 1

    /** Error codes the service sends in an `error` frame. */
    object ErrorCode {
        const val BAD_REQUEST = "bad_request"
        const val QUOTA_EXCEEDED = "quota_exceeded"
        const val IDLE_TIMEOUT = "idle_timeout"
        const val UPSTREAM_UNAVAILABLE = "upstream_unavailable"
        const val INTERNAL = "internal"
    }

    /** Close codes the service pairs with those errors. */
    object CloseCode {
        const val BAD_REQUEST = 4400
        const val QUOTA_EXCEEDED = 4402
        const val IDLE_TIMEOUT = 4408
    }

    /**
     * Lenient about extra fields (the protocol may grow) and about explicit JSON
     * nulls. `explicitNulls = false` is what drops `languages`/`hints` from the
     * encoded start frame when they are null.
     */
    internal val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
        encodeDefaults = true
    }

    @Serializable
    data class Audio(
        val encoding: String = AUDIO_ENCODING,
        @SerialName("sample_rate") val sampleRate: Int = SAMPLE_RATE,
        val channels: Int = CHANNELS,
    )

    @Serializable
    data class Hints(val terms: List<String>)

    /** The `start` frame. Every field but [audio] is optional on the wire. */
    @Serializable
    data class Start(
        val type: String = "start",
        val audio: Audio = Audio(),
        /** e.g. `["zh", "en"]`; also decides the server's Simplified→Traditional pass. */
        val languages: List<String>? = null,
        val diarization: Boolean = false,
        val endpointing: Boolean = true,
        val hints: Hints? = null,
    )

    /** One transcript token. */
    @Serializable
    data class Token(
        val text: String = "",
        @SerialName("start_ms") val startMs: Long = 0,
        @SerialName("end_ms") val endMs: Long = 0,
        /** Final tokens are appended once; non-final ones are the replaceable tail. */
        @SerialName("final") val isFinal: Boolean = false,
        /** Diarized speaker, 1-based; absent without diarization. */
        val speaker: Int? = null,
        val language: String? = null,
        val confidence: Double? = null,
    )

    /** A decoded server frame. */
    sealed interface ServerMessage {
        /** The start frame was accepted and the session is live. */
        data class Ready(val sessionId: String?) : ServerMessage

        data class Transcript(
            val tokens: List<Token>,
            val finalAudioMs: Long?,
            val totalAudioMs: Long?,
        ) : ServerMessage

        /** The speaker paused: the final tokens so far close an utterance. */
        data object Endpoint : ServerMessage

        /** Answer to `finalize` (or `end`): every token up to here is final. */
        data object Finalized : ServerMessage

        /** The stream is complete; the server closes with 1000 next. */
        data object Done : ServerMessage

        /** The session failed; the server closes next. */
        data class Error(val code: String, val message: String) : ServerMessage
    }

    /** Superset of every server frame's fields, mapped into [ServerMessage]. */
    @Serializable
    private data class Wire(
        val type: String = "",
        @SerialName("session_id") val sessionId: String? = null,
        val tokens: List<Token> = emptyList(),
        @SerialName("final_audio_ms") val finalAudioMs: Long? = null,
        @SerialName("total_audio_ms") val totalAudioMs: Long? = null,
        val code: String? = null,
        val message: String? = null,
    )

    /** Encode the start frame. */
    fun encodeStart(start: Start): String = json.encodeToString(Start.serializer(), start)

    /**
     * Decode one server frame, or null when it is not parseable JSON or carries
     * a `type` this client does not know (skipped, so the protocol can grow).
     */
    fun decode(payload: String): ServerMessage? {
        val wire =
            try {
                json.decodeFromString(Wire.serializer(), payload)
            } catch (_: IllegalArgumentException) {
                // SerializationException extends IllegalArgumentException — this
                // catches malformed JSON and type mismatches alike.
                return null
            }
        return when (wire.type) {
            "ready" -> ServerMessage.Ready(wire.sessionId)
            "transcript" -> ServerMessage.Transcript(wire.tokens, wire.finalAudioMs, wire.totalAudioMs)
            "endpoint" -> ServerMessage.Endpoint
            "finalized" -> ServerMessage.Finalized
            "done" -> ServerMessage.Done
            "error" -> ServerMessage.Error(wire.code ?: ErrorCode.INTERNAL, wire.message.orEmpty())
            else -> null
        }
    }

    /**
     * Encode 16-bit PCM samples as little-endian bytes for a binary WS frame,
     * matching `pcm_to_le_bytes` in the desktop's `audio/resample.rs`.
     */
    fun pcmToLeBytes(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            val s = samples[i].toInt()
            out[i * 2] = (s and 0xFF).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }
}

/** An `error` frame from the service. The stream is dead from that point. */
class ParleyStreamError(
    val code: String,
    override val message: String,
) : Exception() {
    override fun equals(other: Any?): Boolean =
        other is ParleyStreamError && other.code == code && other.message == message

    override fun hashCode(): Int = 31 * code.hashCode() + message.hashCode()

    override fun toString(): String = "ParleyStreamError(code=$code, message=$message)"
}

/**
 * Turns the v2 frame stream into transcript segments via a [SegmentBuilder] —
 * the same read-loop semantics the desktop's `SegmentBuilder` callers use,
 * extracted so they are testable without a socket.
 *
 * - `transcript`: final tokens are pushed into the open run, the run is
 *   surfaced as committed text, and the non-final tokens become the tail.
 * - `endpoint` / `finalized`: the open run closes as an utterance.
 * - `done`: [finished] flips.
 * - `error`: throws [ParleyStreamError].
 *
 * Not thread-safe: feed it from one thread.
 */
class ParleyStreamParser(
    source: String = "mix",
    idPrefix: String = source,
    timeOffsetMs: Long = 0,
    sink: (TranscriptSegment) -> Unit,
) {
    private val builder = SegmentBuilder(source, idPrefix, timeOffsetMs, sink)

    /** Set once `ready` arrives — the session is live. */
    var ready: Boolean = false
        private set

    /** The service's id for this session, from `ready`. Diagnostics only. */
    var sessionId: String? = null
        private set

    /** Set once `done` arrives — the stream ended normally. */
    var finished: Boolean = false
        private set

    /**
     * Feed one raw text frame from the socket and return what it was, or null
     * when it was skipped (unparseable or an unknown type). Throws
     * [ParleyStreamError] on an `error` frame.
     */
    @Throws(ParleyStreamError::class)
    fun process(payload: String): ParleyStreamProtocol.ServerMessage? {
        val message = ParleyStreamProtocol.decode(payload) ?: return null
        when (message) {
            is ParleyStreamProtocol.ServerMessage.Ready -> {
                ready = true
                sessionId = message.sessionId
            }
            is ParleyStreamProtocol.ServerMessage.Transcript -> applyTokens(message.tokens)
            ParleyStreamProtocol.ServerMessage.Endpoint,
            ParleyStreamProtocol.ServerMessage.Finalized -> builder.endpoint()
            ParleyStreamProtocol.ServerMessage.Done -> finished = true
            is ParleyStreamProtocol.ServerMessage.Error ->
                throw ParleyStreamError(message.code, message.message)
        }
        return message
    }

    private fun applyTokens(tokens: List<ParleyStreamProtocol.Token>) {
        val tail = StringBuilder()
        var tailSpeaker = builder.currentSpeaker
        var tailStart = builder.currentEnd

        for (tok in tokens) {
            val spk = tok.speaker ?: 0
            if (tok.isFinal) {
                builder.pushFinal(tok.text, spk, tok.startMs, tok.endMs)
            } else {
                if (tail.isEmpty()) {
                    tailSpeaker = spk
                    tailStart = tok.startMs
                }
                tail.append(tok.text)
            }
        }

        builder.emitCommitted()
        builder.emitTail(tail.toString(), tailSpeaker, tailStart)
    }
}
