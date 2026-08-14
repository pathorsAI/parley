package com.pathors.parley.kit

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/** Events surfaced by the relay session. */
sealed interface SttRelayEvent {
    /** A committed run or the tentative tail — upsert by [TranscriptSegment.id]. */
    data class Segment(val segment: TranscriptSegment) : SttRelayEvent

    /** Stream ended: normally (`finished`/server close after finalize) or not. */
    data class Closed(val reason: String) : SttRelayEvent

    /** The stream died — in-band Soniox error frame, or a rejected handshake. */
    data class Error(val message: String) : SttRelayEvent

    /**
     * The account ran out of hosted STT quota. A distinguished case of [Error]
     * so the UI can route to an upgrade prompt instead of a generic failure;
     * see the class doc for exactly which wire conditions produce it.
     */
    data class QuotaExceeded(val message: String) : SttRelayEvent
}

/**
 * WebSocket client for Parley's hosted STT relay
 * (`wss://api.parley.tw/stt/stream`), speaking the Soniox wire protocol with the
 * vendor key omitted — the relay injects it. Mirrors the desktop's relay-mode
 * behavior in `src-tauri/src/transcription/soniox.rs` and the iOS
 * `SttRelayClient.swift`:
 *
 * - `Authorization: Bearer <cloud session token>` on the handshake
 * - `?feature=` query param for billing attribution (parley-internal#29)
 * - first frame is the Soniox config (no `api_key` — the relay injects it)
 * - `{"type":"keepalive"}` every 2 s (Soniox 408s idle connections)
 * - binary frames are 16 kHz mono s16le PCM
 * - on stop: send `{"type":"finalize"}` and — critically — do NOT close the
 *   socket. The relay must forward the finalize to Soniox and stream the
 *   flushed tail back; closing now would truncate the last utterance. The relay
 *   closes once Soniox finishes.
 *
 * Terminal events, matching the Swift client's strings:
 * - Soniox `finished` marker → `Closed("finished")`
 * - server close → `Closed("close code=<code> <reason>")`
 * - in-band error frame → `Error("relay error <code>: <message>")`
 *
 * Two Android-only additions, because OkHttp exposes what `URLSessionWebSocketTask`
 * hid: a failed HTTP handshake is reported with its status (the relay answers
 * 401 unauthorized / 402 quota_exhausted / 429 too_many_sessions before the
 * upgrade), and the quota cases are raised as [SttRelayEvent.QuotaExceeded]
 * rather than a generic error — HTTP 402 on the handshake, in-band `error_code`
 * 402, and the relay's mid-session hard cut (close 1011 "quota cap reached").
 *
 * One session per instance: after a terminal event the client is spent. Events
 * are delivered through a single-consumer [Flow] backed by an unbounded channel,
 * so nothing is dropped if collection starts late; the flow completes after the
 * terminal event.
 */
class SttRelayClient(private val options: Options) {

    /**
     * @property bearerToken cloud session token for the `Authorization` header.
     * @property relayUrl `wss://`/`ws://` (or `https://`/`http://`) relay endpoint.
     * @property model advisory model name; the relay forces the real model server-side.
     * @property languageHints e.g. `listOf("zh", "en")`; also decides the relay's
     *   Simplified→Traditional rewrite pass.
     * @property feature billing attribution — one of [Feature]. Anything else is
     *   recorded as unattributed by the relay.
     */
    data class Options(
        val bearerToken: String,
        val relayUrl: String = SttRelayClient.DEFAULT_RELAY_URL,
        val model: String = SttRelayClient.DEFAULT_MODEL,
        val languageHints: List<String>? = null,
        val feature: String = SttRelayClient.Feature.MEETING,
    )

    /** Billing attribution tags the relay recognizes (`?feature=`). */
    object Feature {
        const val MEETING = "meeting"
        const val VOICE_TYPING = "voice_typing"
        const val REALTIME = "realtime"
    }

    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            // Application-level keepalive frames instead of protocol pings, so
            // the relay and Soniox both see the traffic they expect.
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .build()

    private val eventChannel = Channel<SttRelayEvent>(Channel.UNLIMITED)

    /** Transcription events. Single consumer; completes after a terminal event. */
    val events: Flow<SttRelayEvent> = eventChannel.receiveAsFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var parser: SonioxStreamParser? = null
    @Volatile private var keepaliveJob: Job? = null
    @Volatile private var openSignal: CompletableDeferred<Unit>? = null

    private val finalizeSent = AtomicBoolean(false)
    private val terminated = AtomicBoolean(false)

    /** True once the session has ended (closed, errored, or cancelled). */
    val isTerminated: Boolean
        get() = terminated.get()

    /**
     * Connect, send the config frame, and start the keepalive loop. Suspends
     * until the handshake resolves.
     *
     * A rejected handshake is **not** thrown: like every other failure it
     * arrives on [events] (as [SttRelayEvent.QuotaExceeded] or
     * [SttRelayEvent.Error]) so callers have one place to watch. Only a
     * malformed [Options.relayUrl] throws, as `IllegalArgumentException`.
     */
    suspend fun connect() {
        check(webSocket == null) { "SttRelayClient is single-use; connect() was already called" }

        val request =
            Request.Builder()
                .url(buildUrl())
                .addHeader("Authorization", "Bearer ${options.bearerToken}")
                .build()

        parser = SonioxStreamParser(SOURCE) { segment -> emit(SttRelayEvent.Segment(segment)) }

        val opened = CompletableDeferred<Unit>()
        openSignal = opened
        webSocket = client.newWebSocket(request, RelayListener())
        opened.await()
        if (terminated.get()) return

        // Relay mode: api_key stays null; the relay injects the master key.
        val config =
            SonioxProtocol.Config(
                apiKey = null,
                model = options.model,
                languageHints = options.languageHints,
            )
        webSocket?.send(SonioxProtocol.encodeConfig(config))
        startKeepalive()
    }

    /**
     * Stream one chunk of 16 kHz mono s16le PCM.
     *
     * Suspends while more than [MAX_QUEUED_BYTES] sit unsent in OkHttp's write
     * queue, so a caller decoding a file faster than realtime is throttled to
     * the socket instead of buffering the whole file in memory. A no-op once the
     * session has ended.
     */
    suspend fun sendPcm(bytes: ByteArray) {
        val ws = webSocket ?: return
        while (ws.queueSize() > MAX_QUEUED_BYTES) {
            if (terminated.get()) return
            delay(BACKPRESSURE_POLL_MS)
        }
        if (terminated.get()) return
        ws.send(bytes.toByteString())
    }

    /** [sendPcm] for samples that have not been packed to bytes yet. */
    suspend fun sendPcm(samples: ShortArray) {
        sendPcm(SonioxProtocol.pcmToLeBytes(samples))
    }

    /**
     * Input drained: send finalize and let the relay drain the tail. The socket
     * stays open until the server closes it (or `finished` arrives). Idempotent.
     */
    suspend fun finish() {
        val ws = webSocket ?: return
        if (!finalizeSent.compareAndSet(false, true)) return
        keepaliveJob?.cancel()
        // OkHttp's write queue is FIFO, so the finalize lands after every PCM
        // frame already handed over — no drain wait needed here.
        ws.send(SonioxProtocol.FINALIZE_FRAME)
        // Deliberately no close() here — see the class doc.
    }

    /**
     * Hard teardown (app shutdown, user abort). Idempotent.
     *
     * Closes with 1000, matching the Swift client's `.normalClosure`, and lets
     * OkHttp finish the close handshake — the private [OkHttpClient]'s worker
     * threads then idle out on their own, so nothing here truncates the frame
     * still on its way out.
     */
    fun cancel() {
        keepaliveJob?.cancel()
        webSocket?.close(NORMAL_CLOSURE, null)
        if (terminated.compareAndSet(false, true)) {
            eventChannel.close()
        }
        scope.cancel()
    }

    // MARK: internals

    /**
     * Mirrors the Swift client, which *replaces* the query with a single
     * `feature` item rather than appending to whatever the URL carried.
     */
    private fun buildUrl(): HttpUrl {
        val raw = options.relayUrl
        val normalized =
            when {
                raw.startsWith("wss://", ignoreCase = true) -> "https://" + raw.substring(6)
                raw.startsWith("ws://", ignoreCase = true) -> "http://" + raw.substring(5)
                else -> raw
            }
        return normalized
            .toHttpUrl()
            .newBuilder()
            .query(null)
            .addQueryParameter("feature", options.feature)
            .build()
    }

    private fun emit(event: SttRelayEvent) {
        eventChannel.trySend(event)
    }

    private fun startKeepalive() {
        keepaliveJob =
            scope.launch {
                while (isActive) {
                    delay(SonioxProtocol.KEEPALIVE_INTERVAL_MS)
                    if (terminated.get() || finalizeSent.get()) break
                    val ws = webSocket ?: break
                    ws.send(SonioxProtocol.KEEPALIVE_FRAME)
                }
            }
    }

    /** Deliver the one terminal event and close the stream. Subsequent calls no-op. */
    private fun terminate(event: SttRelayEvent) {
        openSignal?.complete(Unit)
        if (!terminated.compareAndSet(false, true)) return
        keepaliveJob?.cancel()
        emit(event)
        eventChannel.close()
        scope.cancel()
    }

    private fun handlePayload(payload: String) {
        if (terminated.get()) return
        val active = parser ?: return
        try {
            active.process(payload)
        } catch (e: SonioxStreamError) {
            val message = "relay error ${e.code}: ${e.message}"
            terminate(
                if (e.code == HTTP_PAYMENT_REQUIRED) SttRelayEvent.QuotaExceeded(message)
                else SttRelayEvent.Error(message)
            )
            webSocket?.cancel()
            return
        }
        if (active.finished) {
            terminate(SttRelayEvent.Closed("finished"))
            webSocket?.cancel()
        }
    }

    private fun closeEvent(code: Int, reason: String): SttRelayEvent {
        val text = "close code=$code $reason"
        return if (code == CLOSE_CODE_INTERNAL && reason.contains("quota", ignoreCase = true)) {
            SttRelayEvent.QuotaExceeded(text)
        } else {
            SttRelayEvent.Closed(text)
        }
    }

    private fun failureEvent(t: Throwable, response: okhttp3.Response?): SttRelayEvent {
        if (response == null) {
            // Transport died mid-stream. The Swift client reported this as a
            // close with an unknown code; keep the shape, add the cause.
            return SttRelayEvent.Closed("close code=0 ${t.message ?: t.javaClass.simpleName}")
        }
        val message = "relay handshake failed: HTTP ${response.code} ${response.message}"
        return if (response.code == HTTP_PAYMENT_REQUIRED) {
            SttRelayEvent.QuotaExceeded(message)
        } else {
            SttRelayEvent.Error(message)
        }
    }

    private inner class RelayListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            openSignal?.complete(Unit)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handlePayload(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            handlePayload(bytes.utf8())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            terminate(closeEvent(code, reason))
            webSocket.close(NORMAL_CLOSURE, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            terminate(closeEvent(code, reason))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
            terminate(failureEvent(t, response))
        }
    }

    companion object {
        const val DEFAULT_RELAY_URL = "wss://api.parley.tw/stt/stream"
        const val DEFAULT_MODEL = "stt-rt-v5"

        /** A phone has one mic; speaker identity comes from provider diarization. */
        const val SOURCE = "mix"

        /**
         * Cap on bytes handed to OkHttp but not yet on the wire (~32 s of 16 kHz
         * mono s16le). Streaming a decoded file blocks here instead of growing
         * the queue without bound.
         */
        const val MAX_QUEUED_BYTES = 1L * 1024 * 1024

        private const val BACKPRESSURE_POLL_MS = 10L
        private const val CONNECT_TIMEOUT_SECONDS = 15L
        private const val NORMAL_CLOSURE = 1000
        private const val CLOSE_CODE_INTERNAL = 1011
        private const val HTTP_PAYMENT_REQUIRED = 402
    }
}
