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

    /** Stream ended: normally (`done`, or the server closing after `end`) or not. */
    data class Closed(val reason: String) : SttRelayEvent

    /**
     * The stream died — an in-band `error` frame, or a rejected handshake.
     *
     * [httpStatus] is set only for a rejected handshake, where it is the HTTP
     * status the service answered the upgrade with (401 unauthorized, 429
     * too_many_sessions, …). It is null for an in-band error frame: those codes
     * describe the stream (`upstream_unavailable`, `idle_timeout`, …), not the
     * caller's sign-in, so they must never read as "your session is dead".
     */
    data class Error(val message: String, val httpStatus: Int? = null) : SttRelayEvent {
        /** The relay refused this session's token: the caller has to sign in again. */
        val isUnauthorized: Boolean get() = httpStatus == HTTP_UNAUTHORIZED

        private companion object {
            const val HTTP_UNAUTHORIZED = 401
        }
    }

    /**
     * The account ran out of hosted STT quota. A distinguished case of [Error]
     * so the UI can route to an upgrade prompt instead of a generic failure;
     * see the class doc for exactly which wire conditions produce it.
     */
    data class QuotaExceeded(val message: String) : SttRelayEvent
}

/**
 * WebSocket client for Parley's hosted streaming transcription, speaking
 * Parley's own stream protocol v2 (`wss://api.parley.tw/stt/v2/stream`, see
 * [ParleyStreamProtocol]):
 *
 * - `Authorization: Bearer <cloud session token>` on the handshake
 * - `?feature=` query param for billing attribution (parley-internal#29)
 * - first frame is `start`: audio format, languages, diarization, endpointing
 *   and hint terms
 * - `{"type":"keepalive"}` every 2 s, so an idle session is not timed out
 * - binary frames are 16 kHz mono s16le PCM
 * - `ready` from the server is "connected" — [awaitOpen] resolves on it
 * - on stop: send `{"type":"end"}` and — critically — do NOT close the socket.
 *   The service finalizes, streams the flushed tail back, sends `done` and then
 *   closes; closing first would truncate the last utterance.
 *
 * Terminal events:
 * - `done` → `Closed("finished")`
 * - server close → `Closed("close code=<code> <reason>")`
 * - `error` frame → `Error("relay error <code>: <message>")`, or
 *   [SttRelayEvent.QuotaExceeded] for `quota_exceeded`
 *
 * A failed HTTP handshake is reported with its status (the service answers
 * 401 unauthorized / 402 quota_exhausted / 429 too_many_sessions before the
 * upgrade), and the quota cases are raised as [SttRelayEvent.QuotaExceeded]
 * rather than a generic error — HTTP 402 on the handshake, the
 * `quota_exceeded` error frame, and close code 4402 (the same verdict when the
 * frame itself was lost).
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
class SttRelayClient(private val options: Options) : PcmSink {

    /**
     * @property bearerToken cloud session token for the `Authorization` header.
     * @property relayUrl `wss://`/`ws://` (or `https://`/`http://`) stream
     *   endpoint. A URL still pointing at the v1 path (`/stt/stream`) is moved
     *   to `/stt/v2/stream`; see [streamUrl].
     * @property languageHints sent as the start frame's `languages`, e.g.
     *   `listOf("zh", "en")`; also decides the server's Simplified→Traditional
     *   rewrite pass.
     * @property diarization ask the service to label speakers.
     * @property endpointing ask the service to mark utterance ends (`endpoint`).
     * @property hintTerms words the recognizer should favor (names, jargon).
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
        val languageHints: List<String>? = null,
        val feature: String = SttRelayClient.Feature.MEETING,
        val idPrefix: String? = null,
        val timeOffsetMs: Long = 0,
        val diarization: Boolean = true,
        val endpointing: Boolean = true,
        val hintTerms: List<String> = emptyList(),
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
            //  - `{"type":"keepalive"}` every 2 s keeps the session from being
            //    timed out as idle. It is never answered, so it says nothing
            //    about the socket.
            //  - A WebSocket ping is answered by the peer's stack, and is the
            //    only thing that notices a half-open connection.
            //
            // Leaving this at 0 was how a stalled socket became silent forever:
            // nothing ever failed, `terminated` never flipped, and everything
            // waiting on it waited for good. See [RelayLiveness].
            .pingInterval(LIVENESS.okHttpPingIntervalMs, TimeUnit.MILLISECONDS)
            // `X-Parley-Client` on the upgrade request, so the cloud can stamp
            // the STT session row with the build that opened it. Here rather
            // than in [open] so no future second socket path can miss it.
            .addInterceptor(ParleyClientHeader.interceptor)
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
    @Volatile private var parser: ParleyStreamParser? = null
    @Volatile private var keepaliveJob: Job? = null
    @Volatile private var writerJob: Job? = null
    @Volatile private var openSignal: CompletableDeferred<Unit>? = null

    private val endSent = AtomicBoolean(false)
    private val terminated = AtomicBoolean(false)

    /** True once the session has ended (closed, errored, or cancelled). */
    val isTerminated: Boolean
        get() = terminated.get()

    /** The service's id for this session, once `ready` has arrived. Diagnostics only. */
    val sessionId: String? get() = parser?.sessionId

    /**
     * Open the socket and queue the start frame. Returns immediately — the
     * handshake is still in flight.
     *
     * [enqueuePcm] may be called before *or* the moment this returns: audio sits
     * in the outbound queue until the writer starts, and OkHttp then buffers
     * frames until the upgrade completes and writes them in order, so the start
     * frame is guaranteed to reach the service ahead of any audio. That is what
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
            ParleyStreamParser(
                source = SOURCE,
                idPrefix = options.idPrefix ?: SOURCE,
                timeOffsetMs = options.timeOffsetMs,
            ) { segment -> emit(SttRelayEvent.Segment(segment)) }

        openSignal = CompletableDeferred()
        webSocket = client.newWebSocket(request, RelayListener())

        webSocket?.send(ParleyStreamProtocol.encodeStart(startFrame(options)))
        startKeepalive()
        startWriter()
    }

    /**
     * Suspend until the session is live (`ready` arrived) or has ended, one way
     * or the other.
     */
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
     *
     * A live meeting does not call this directly: it goes through
     * [RelayAudioBridge], which holds the audio spoken while there is no leg
     * and flushes it into the next one.
     */
    override fun enqueuePcm(bytes: ByteArray) {
        if (terminated.get()) return
        outbound.trySend(bytes)
    }

    /** [enqueuePcm] for samples that have not been packed to bytes yet. */
    fun enqueuePcm(samples: ShortArray) {
        enqueuePcm(ParleyStreamProtocol.pcmToLeBytes(samples))
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
        sendPcm(ParleyStreamProtocol.pcmToLeBytes(samples))
    }

    /**
     * Input drained: send `end` and let the service flush the tail. The socket
     * stays open until `done` arrives or the server closes it. Idempotent.
     *
     * The queued audio is flushed first — an `end` that overtakes the last few
     * seconds of speech makes the service flush a tail that is missing them. The
     * wait is bounded because a dead socket must not be able to hold up the end
     * of a meeting; past the bound the writer is dropped and `end` goes out
     * regardless, which matches what iOS does with its `drainTimeout`.
     */
    suspend fun finish() {
        val ws = webSocket ?: return
        if (!endSent.compareAndSet(false, true)) return
        keepaliveJob?.cancel()
        outbound.close()
        val drained = withTimeoutOrNull(DRAIN_TIMEOUT_MS) { writerJob?.join(); true } ?: false
        if (!drained) writerJob?.cancel()
        ws.send(ParleyStreamProtocol.END_FRAME)
        // Deliberately no close() here — see the class doc.
    }

    /**
     * Ask the service to finalize everything received so far without ending the
     * stream: the remaining tokens come back final, followed by `finalized`,
     * which closes the open utterance. Audio may keep flowing. A no-op before
     * [open] and after [finish].
     */
    fun requestFinalize() {
        if (terminated.get() || endSent.get()) return
        webSocket?.send(ParleyStreamProtocol.FINALIZE_FRAME)
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

    private fun buildUrl(): HttpUrl = streamUrl(options.relayUrl, options.feature)

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
                    delay(ParleyStreamProtocol.KEEPALIVE_INTERVAL_MS)
                    if (terminated.get() || endSent.get()) break
                    val ws = webSocket ?: break
                    ws.send(ParleyStreamProtocol.KEEPALIVE_FRAME)
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
        val message =
            try {
                active.process(payload)
            } catch (e: ParleyStreamError) {
                terminate(errorEvent(e))
                webSocket?.cancel()
                return
            }
        when (message) {
            is ParleyStreamProtocol.ServerMessage.Ready -> openSignal?.complete(Unit)
            ParleyStreamProtocol.ServerMessage.Done -> {
                terminate(SttRelayEvent.Closed(CLOSED_FINISHED))
                // The service closes with 1000 right after `done`; answer in kind.
                webSocket?.close(NORMAL_CLOSURE, null)
            }
            else -> Unit
        }
    }

    private fun closeEvent(code: Int, reason: String): SttRelayEvent =
        streamCloseEvent(code, reason)

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
            SttRelayEvent.Error(message, httpStatus = response.code)
        }
    }

    private inner class RelayListener : WebSocketListener() {
        // The upgrade alone is not "connected": [awaitOpen] waits for `ready`,
        // which the service sends once the start frame is accepted.
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) = Unit

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
        const val DEFAULT_RELAY_URL = "wss://api.parley.tw/stt/v2/stream"

        /** The terminal `Closed` reason for a stream that ended with `done`. */
        const val CLOSED_FINISHED = "finished"

        /** A phone has one mic; speaker identity comes from server-side diarization. */
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
         * sending the `end` frame anyway.
         */
        private const val DRAIN_TIMEOUT_MS = 3_000L

        private const val BACKPRESSURE_POLL_MS = 10L
        private const val CONNECT_TIMEOUT_SECONDS = 15L
        private const val NORMAL_CLOSURE = 1000
        private const val HTTP_PAYMENT_REQUIRED = 402

        private const val V1_STREAM_PATH = "/stt/stream"
        private const val V2_STREAM_PATH = "/stt/v2/stream"

        /**
         * The upgrade URL for [relayUrl]: `ws(s)://` becomes `http(s)://` for
         * OkHttp, a v1 stream path (`…/stt/stream`) is moved to the v2 one
         * (`…/stt/v2/stream`), and the query is *replaced* with a single
         * `feature` item rather than appended to — the same as the Swift client.
         */
        fun streamUrl(relayUrl: String, feature: String): HttpUrl {
            val normalized =
                when {
                    relayUrl.startsWith("wss://", ignoreCase = true) -> "https://" + relayUrl.substring(6)
                    relayUrl.startsWith("ws://", ignoreCase = true) -> "http://" + relayUrl.substring(5)
                    else -> relayUrl
                }
            val url = normalized.toHttpUrl()
            val path = url.encodedPath.trimEnd('/')
            val builder = url.newBuilder().query(null).addQueryParameter("feature", feature)
            if (path.endsWith(V1_STREAM_PATH)) {
                builder.encodedPath(path.removeSuffix(V1_STREAM_PATH) + V2_STREAM_PATH)
            }
            return builder.build()
        }

        /** The `start` frame for [options]. */
        fun startFrame(options: Options): ParleyStreamProtocol.Start =
            ParleyStreamProtocol.Start(
                languages = options.languageHints?.takeIf { it.isNotEmpty() },
                diarization = options.diarization,
                endpointing = options.endpointing,
                hints = options.hintTerms
                    .takeIf { it.isNotEmpty() }
                    ?.let { ParleyStreamProtocol.Hints(it) },
            )

        /**
         * The terminal event for an `error` frame. `quota_exceeded` is its own
         * event so the UI can route to an upgrade prompt.
         */
        fun errorEvent(error: ParleyStreamError): SttRelayEvent {
            val message = "relay error ${error.code}: ${error.message}"
            return if (error.code == ParleyStreamProtocol.ErrorCode.QUOTA_EXCEEDED) {
                SttRelayEvent.QuotaExceeded(message)
            } else {
                SttRelayEvent.Error(message)
            }
        }

        /**
         * The terminal event for a server close. Normally an `error` or `done`
         * frame has already decided it; this only matters when the frame never
         * arrived, and then 4402 still means "out of quota".
         */
        fun streamCloseEvent(code: Int, reason: String): SttRelayEvent {
            val text = "close code=$code $reason"
            return if (code == ParleyStreamProtocol.CloseCode.QUOTA_EXCEEDED) {
                SttRelayEvent.QuotaExceeded(text)
            } else {
                SttRelayEvent.Closed(text)
            }
        }
    }
}
