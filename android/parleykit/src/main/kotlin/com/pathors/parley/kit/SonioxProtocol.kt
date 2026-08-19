package com.pathors.parley.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The Soniox realtime wire protocol, as spoken through Parley's hosted STT
 * relay (`wss://api.parley.tw/stt/stream`). The relay is a byte-for-byte
 * passthrough of Soniox frames downstream, and injects the vendor key into the
 * first config frame upstream — so the client speaks plain Soniox minus the
 * `api_key` field. Mirrors `src-tauri/src/transcription/soniox.rs`.
 */
object SonioxProtocol {
    /**
     * Endpoint markers. `<end>` closes an utterance; `<fin>` is the final token
     * emitted when the whole stream ends.
     */
    const val TOKEN_END = "<end>"
    const val TOKEN_FIN = "<fin>"

    /**
     * Keepalive cadence in milliseconds — Soniox 408s an idle connection; the
     * desktop sends this every 2 seconds and the relay passes it through.
     */
    const val KEEPALIVE_INTERVAL_MS = 2_000L
    const val KEEPALIVE_FRAME = """{"type":"keepalive"}"""
    const val FINALIZE_FRAME = """{"type":"finalize"}"""

    /**
     * Everything in the pipeline is 16 kHz mono s16le, matching the desktop's
     * `TARGET_SAMPLE_RATE` and the relay's metering (32 000 bytes/second).
     */
    const val SAMPLE_RATE = 16_000
    const val AUDIO_FORMAT = "pcm_s16le"

    /**
     * Lenient about extra fields (Soniox adds `confidence`, `language`, … over
     * time) and about explicit JSON nulls, matching Swift's
     * `decodeIfPresent(_:) ?? default`. `explicitNulls = false` is what drops
     * `api_key`/`language_hints` from the encoded config when they are null,
     * matching the Rust `skip_serializing_if = "Option::is_none"`.
     */
    internal val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
        encodeDefaults = true
    }

    /**
     * First frame on the socket. In relay mode [apiKey] stays null — the relay
     * injects the master key server-side and forces the model, so neither
     * secret nor model choice rides in the client frame.
     */
    @Serializable
    data class Config(
        @SerialName("api_key") val apiKey: String? = null,
        val model: String,
        @SerialName("audio_format") val audioFormat: String = SonioxProtocol.AUDIO_FORMAT,
        @SerialName("sample_rate") val sampleRate: Int = SonioxProtocol.SAMPLE_RATE,
        @SerialName("num_channels") val numChannels: Int = 1,
        @SerialName("language_hints") val languageHints: List<String>? = null,
        @SerialName("enable_endpoint_detection") val enableEndpointDetection: Boolean = true,
        @SerialName("enable_speaker_diarization") val enableSpeakerDiarization: Boolean = true,
    )

    @Serializable
    data class Token(
        val text: String = "",
        @SerialName("is_final") val isFinal: Boolean = false,
        @SerialName("start_ms") val startMs: Long = 0,
        @SerialName("end_ms") val endMs: Long = 0,
        /**
         * Diarized speaker — Soniox sends this as a STRING (e.g. "1"), or omits
         * it on control tokens like `<end>`. Parsed to a number in the read loop.
         */
        val speaker: String = "",
    )

    @Serializable
    data class Response(
        val tokens: List<Token> = emptyList(),
        @SerialName("error_code") val errorCode: Int? = null,
        @SerialName("error_message") val errorMessage: String? = null,
        val finished: Boolean = false,
    )

    /** Encode the config frame. */
    fun encodeConfig(config: Config): String = json.encodeToString(Config.serializer(), config)

    /**
     * Decode one downstream frame, or null when it is not parseable Soniox JSON
     * (the desktop logs and continues; so do we).
     */
    fun decodeResponse(payload: String): Response? =
        try {
            json.decodeFromString(Response.serializer(), payload)
        } catch (_: IllegalArgumentException) {
            // SerializationException extends IllegalArgumentException — this
            // catches malformed JSON and type mismatches alike.
            null
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

/**
 * In-band Soniox error frame (e.g. relay 402 surfaced mid-stream, rejected
 * session). The stream is dead from that point.
 */
class SonioxStreamError(
    val code: Int,
    override val message: String,
) : Exception() {
    override fun equals(other: Any?): Boolean =
        other is SonioxStreamError && other.code == code && other.message == message

    override fun hashCode(): Int = 31 * code + message.hashCode()

    override fun toString(): String = "SonioxStreamError(code=$code, message=$message)"
}

/**
 * Parses the Soniox token stream into transcript segments via a [SegmentBuilder]
 * — the exact read-loop semantics of `soniox.rs::run_session`, extracted so they
 * are testable without a socket.
 *
 * Not thread-safe: feed it from one thread.
 */
class SonioxStreamParser(
    source: String = "mix",
    idPrefix: String = source,
    timeOffsetMs: Long = 0,
    sink: (TranscriptSegment) -> Unit,
) {
    private val builder = SegmentBuilder(source, idPrefix, timeOffsetMs, sink)

    /** Set once a `finished` marker arrives — the stream ended normally. */
    var finished: Boolean = false
        private set

    /**
     * Feed one raw text frame from the socket. Throws [SonioxStreamError] on an
     * in-band error frame; unparseable frames are skipped (the desktop logs and
     * continues).
     */
    @Throws(SonioxStreamError::class)
    fun process(payload: String) {
        val resp = SonioxProtocol.decodeResponse(payload) ?: return

        val code = resp.errorCode
        if (code != null) {
            throw SonioxStreamError(code, resp.errorMessage ?: "")
        }

        val tail = StringBuilder()
        var tailSpeaker = builder.currentSpeaker
        var tailStart = builder.currentEnd
        var endpoint = false

        for (tok in resp.tokens) {
            if (tok.text == SonioxProtocol.TOKEN_END || tok.text == SonioxProtocol.TOKEN_FIN) {
                endpoint = true
                continue
            }
            val spk = tok.speaker.toIntOrNull() ?: 0
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
        if (endpoint) {
            builder.endpoint()
        }
        if (resp.finished) {
            finished = true
        }
    }
}
