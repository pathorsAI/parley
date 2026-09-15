package com.pathors.parley.kit

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
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
 *
 * ## Audio goes in through a queue, not straight onto the socket
 *
 * [enqueuePcm] drops a chunk into a bounded, **drop-oldest** queue that a single
 * writer coroutine drains in order; only that writer ever waits on the socket.
 * The producer is a live recording, and a live recording has exactly one
 * irreplaceable output — the audio file. A transcript with a hole in it can be
 * rebuilt from that file after the fact; audio the microphone was never allowed
 * to hand over is gone for good. So when the socket cannot keep up, the oldest
 * queued chunk is thrown away and the caller is never held up, which is the same
 * bargain iOS strikes (`SttRelayClient.swift`, `bufferingNewest`).
 *
 * [sendPcm] is the other half of that bargain, for a caller who is *not* a
 * microphone: streaming a decoded file runs faster than realtime and losing part
 * of it would be pointless, so it throttles itself against the socket and then
 * hands over through the same queue, keeping one ordered path to the wire.
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
     * @property idPrefix stem for committed segment ids, defaulting to the
     *   source (`mix`). A recording that reopens the relay mid-meeting passes a
     *   distinct prefix per leg — see [SegmentBuilder].
     * @property timeOffsetMs added to every timestamp this session emits, so a
     *   reconnected leg lands after the audio that preceded it rather than at 0.
     */
    data class Options(
        val bearerToken: String,
        val relayUrl: String = SttRelayClient.DEFAULT_RELAY_URL,
        val model: String = SttRelayClient.DEFAULT_MODEL,
        val languageHints: List<String>? = null,
        val feature: String = SttRelayClient.Feature.MEETING,
        val idPrefix: String? = null,
        val timeOffsetMs: Long = 0,
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
            // Protocol pings *in addition to* the application keepalive below,
            // not instead of it — they answer different questions:
            //
            //  - `{"type":"keepalive"}` every 2 s keeps the traffic the relay
            //    and Soniox expect flowing, so the provider does not 408 an
            //    idle session. It is never answered, so it says nothing about
            //    the socket.
            //  - A WebSocket ping is answered by the peer's stack, and is the
            //    only thing that notices a half-open connection.
            //
            // Leaving this at 0 was how a stalled socket became silent forever:
            // nothing ever failed, `terminated` never flipped, and everything
            // waiting on it waited for good. See [RelayLiveness].
            .pingInterval(LIVENESS.okHttpPingIntervalMs, TimeUnit.MILLISECONDS)
            .build()

    private val eventChannel = Channel<SttRelayEvent>(Channel.UNLIMITED)

    /** Transcription events. Single consumer; completes after a terminal event. */
    val events: Flow<SttRelayEvent> = eventChannel.receiveAsFlow()

    private val droppedChunks = AtomicLong()

    /**
     * Audio waiting for the socket. Bounded and drop-oldest by construction, so
     * [enqueuePcm] cannot block, cannot fail and cannot grow the process — see
     * the class docs for why that trade goes this way round.
     *
     * The queue exists from construction rather than from [open], so a caller
     * may start the microphone and the socket at the same moment: nothing is
     * consumed until the writer starts, and nothing is lost.
     */
    private val outbound = Channel<ByteArray>(
        capacity = MAX_QUEUED_CHUNKS,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
        onUndeliveredElement = { droppedChunks.incrementAndGet() },
    )

    /**
     * PCM chunks the queue threw away because the socket could not keep up.
     * Non-zero means a gap in the live transcript — never in the recording.
     */
    val droppedPcmChunks: Long get() = droppedChunks.get()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var parser: SonioxStreamParser? = null
    @Volatile private var keepaliveJob: Job? = null
    @Volatile private var writerJob: Job? = null
    @Volatile private var openSignal: CompletableDeferred<Unit>? = null

    private val finalizeSent = AtomicBoolean(false)
    private val terminated = AtomicBoolean(false)

    /** True once the session has ended (closed, errored, or cancelled). */
    val isTerminated: Boolean
        get() = terminated.get()

    /**
     * Open the socket and queue the config frame. Returns immediately — the
     * handshake is still in flight.
     *
     * [enqueuePcm] may be called before *or* the moment this returns: audio sits
     * in the outbound queue until the writer starts, and OkHttp then buffers
     * frames until the upgrade completes and writes them in order, so the config
     * frame is guaranteed to reach the relay ahead of any audio. That is what
     * lets a caller open the microphone and the socket at the same time instead
     * of making the person holding the phone wait out a round trip before their
     * first word is recorded.
     *
     * A rejected handshake is **not** thrown: like every other failure it
     * arrives on [events] (as [SttRelayEvent.QuotaExceeded] or
     * [SttRelayEvent.Error]) so callers have one place to watch. Only a
     * malformed [Options.relayUrl] throws, as `IllegalArgumentException`.
     */
    fun open() {
        check(webSocket == null) { "SttRelayClient is single-use; connect() was already called" }

        val request =
            Request.Builder()
                .url(buildUrl())
                .addHeader("Authorization", "Bearer ${options.bearerToken}")
                .build()

        parser =
            SonioxStreamParser(
                source = SOURCE,
                idPrefix = options.idPrefix ?: SOURCE,
                timeOffsetMs = options.timeOffsetMs,
            ) { segment -> emit(SttRelayEvent.Segment(segment)) }

        openSignal = CompletableDeferred()
        webSocket = client.newWebSocket(request, RelayListener())

        // Relay mode: api_key stays null; the relay injects the master key.
        val config =
            SonioxProtocol.Config(
                apiKey = null,
                model = options.model,
                languageHints = options.languageHints,
            )
        webSocket?.send(SonioxProtocol.encodeConfig(config))
        startKeepalive()
        startWriter()
    }

    /** Suspend until the handshake resolves, one way or the other. */
    suspend fun awaitOpen() {
        openSignal?.await()
    }

    /** [open] then [awaitOpen]. */
    suspend fun connect() {
        open()
        awaitOpen()
    }

    /**
     * Hand one chunk of 16 kHz mono s16le PCM to the socket **without ever
     * waiting for it**. Never suspends, never blocks, never throws; a no-op once
     * the session has ended.
     *
     * This is the entry point for live capture. The chunk joins the outbound
     * queue and the writer coroutine puts it on the wire when the wire is ready;
     * if the queue is already full — a stalled radio, a relay that stopped
     * reading — the oldest chunk in it is dropped to make room. Transcription
     * loses a few seconds and the microphone loses nothing, which is the only
     * ordering of those two that is recoverable afterwards.
     */
    fun enqueuePcm(bytes: ByteArray) {
        if (terminated.get()) return
        outbound.trySend(bytes)
    }

    /** [enqueuePcm] for samples that have not been packed to bytes yet. */
    fun enqueuePcm(samples: ShortArray) {
        enqueuePcm(SonioxProtocol.pcmToLeBytes(samples))
    }

    /**
     * Stream one chunk of 16 kHz mono s16le PCM, **throttled to the socket**.
     *
     * Suspends while more than [MAX_QUEUED_BYTES] sit unsent in OkHttp's write
     * queue, so a caller decoding a file faster than realtime is paced by the
     * socket instead of buffering the whole file in memory — and, because it
     * only hands a chunk over once there is room, nothing it sends is dropped.
     * A no-op once the session has ended.
     *
     * Live capture must use [enqueuePcm] instead: a microphone cannot be paced,
     * and anything that waits here waits in front of the encoder.
     */
    suspend fun sendPcm(bytes: ByteArray) {
        val ws = webSocket ?: return
        while (ws.queueSize() > MAX_QUEUED_BYTES) {
            if (terminated.get()) return
            delay(BACKPRESSURE_POLL_MS)
        }
        enqueuePcm(bytes)
    }

    /** [sendPcm] for samples that have not been packed to bytes yet. */
    suspend fun sendPcm(samples: ShortArray) {
        sendPcm(SonioxProtocol.pcmToLeBytes(samples))
    }

    /**
     * Input drained: send finalize and let the relay drain the tail. The socket
     * stays open until the server closes it (or `finished` arrives). Idempotent.
     *
     * The queued audio is flushed first — a finalize that overtakes the last few
     * seconds of speech makes the relay flush a tail that is missing them. The
     * wait is bounded because a dead socket must not be able to hold up the end
     * of a meeting; past the bound the writer is dropped and the finalize goes
     * out regardless, which matches what iOS does with its `drainTimeout`.
     */
    suspend fun finish() {
        val ws = webSocket ?: return
        if (!finalizeSent.compareAndSet(false, true)) return
        keepaliveJob?.cancel()
        outbound.close()
        val drained = withTimeoutOrNull(DRAIN_TIMEOUT_MS) { writerJob?.join(); true } ?: false
        if (!drained) writerJob?.cancel()
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
        outbound.close()
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

    /**
     * The one place that waits on the socket.
     *
     * Everything the backpressure loop used to do to its caller it now does
     * here, behind the queue: a socket whose write queue refuses to shrink
     * stalls this coroutine and nothing else. `terminated` is the way out, and
     * the protocol ping is what guarantees it eventually arrives even when the
     * connection is half-open.
     */
    private fun startWriter() {
        writerJob =
            scope.launch {
                for (chunk in outbound) {
                    val ws = webSocket ?: break
                    while (ws.queueSize() > MAX_QUEUED_BYTES) {
                        if (terminated.get()) return@launch
                        delay(BACKPRESSURE_POLL_MS)
                    }
                    if (terminated.get()) return@launch
                    ws.send(chunk.toByteString())
                }
            }
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
        outbound.close()
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
         * mono s16le). The writer waits here instead of growing the queue
         * without bound.
         */
        const val MAX_QUEUED_BYTES = 1L * 1024 * 1024

        /**
         * Chunks held between the producer and the writer. At the 100 ms chunk
         * a live capture emits this is ~51 s (~1.6 MB) of slack — deep enough to
         * cover a slow handshake or a stalled radio, shallow enough that a
         * socket which never recovers cannot grow the process without bound.
         */
        const val MAX_QUEUED_CHUNKS = 512

        /** When to stop believing a quiet socket. See [RelayLiveness]. */
        val LIVENESS = RelayLiveness.STANDARD

        /**
         * How long [finish] waits for queued audio to reach the wire before
         * sending the finalize frame anyway.
         */
        private const val DRAIN_TIMEOUT_MS = 3_000L

        private const val BACKPRESSURE_POLL_MS = 10L
        private const val CONNECT_TIMEOUT_SECONDS = 15L
        private const val NORMAL_CLOSURE = 1000
        private const val CLOSE_CODE_INTERNAL = 1011
        private const val HTTP_PAYMENT_REQUIRED = 402
    }
}
