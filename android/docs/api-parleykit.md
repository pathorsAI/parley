# ParleyKit (Android) — public API

`:parleykit` is a pure Kotlin/JVM module (no Android APIs) holding the transcript
core, ported line-for-line from the iOS `ParleyKit` Swift package, which was
itself a faithful port of the desktop's Rust
(`src-tauri/src/transcription/common.rs`). The unit tests are the contract: if
they drift, the three transcripts drift.

Package: `com.pathors.parley.kit`.

```
mic ──16k mono s16le──▶ RelayAudioBridge ──▶ SttRelayClient (leg N) ◀──▶ Parley stream protocol v2
decoded file ─────────────────────────────▶ SttRelayClient          │      (wss://api.parley.tw/stt/v2/stream)
                                                                    ParleyStreamParser
                                                                           │
                                                                     SegmentBuilder ──▶ Flow<SttRelayEvent>
```

---

## `TranscriptSegment`

```kotlin
@Serializable
data class TranscriptSegment(
    val id: String,
    val source: String,   // always "mix" on mobile
    val speaker: Int,     // diarized index; 0 = unknown/single
    val text: String,
    val isFinal: Boolean,
    val startMs: Long,
    val endMs: Long,
)
```

**Shared type** — the cloud client serializes these too (recording meta carries a
`segments` array), so it lives here rather than inside the relay client. It is
`@Serializable`, camelCase on the wire, matching the desktop's `HistoryEntry`.

Identity rules — **the UI upserts by `id`, it does not append**:

- A committed run re-emits under the same `"{source}-{index}"` id while it grows.
  The index advances only on an endpoint or a speaker change.
- The tentative tail always uses the stable `"{source}-tail"` id. An **empty
  `text` clears** that row.

Timestamps are `Long` ms (the Swift/Rust originals use `UInt64`).

---

## `SttRelayClient`

```kotlin
class SttRelayClient(options: Options) : PcmSink {
    data class Options(
        val bearerToken: String,
        val relayUrl: String = DEFAULT_RELAY_URL,       // "wss://api.parley.tw/stt/v2/stream"
        val languageHints: List<String>? = null,        // sent as `languages`, e.g. listOf("zh", "en")
        val feature: String = Feature.MEETING,
        val idPrefix: String? = null,                   // segment id stem; default "mix"
        val timeOffsetMs: Long = 0,                     // added to every emitted timestamp
        val diarization: Boolean = true,
        val endpointing: Boolean = true,
        val hintTerms: List<String> = emptyList(),      // sent as `hints.terms`
    )

    object Feature {
        const val MEETING = "meeting"
        const val VOICE_TYPING = "voice_typing"
        const val REALTIME = "realtime"
    }

    val events: Flow<SttRelayEvent>
    val isTerminated: Boolean
    val droppedPcmChunks: Long
    val sessionId: String?                       // from `ready`; diagnostics only

    fun open()                                   // returns at once; handshake in flight
    suspend fun awaitOpen()                      // resolves on `ready` *or* on a terminal event
    suspend fun connect()                        // open() + awaitOpen()
    override fun enqueuePcm(bytes: ByteArray)    // live capture: never waits, drop-oldest
    fun enqueuePcm(samples: ShortArray)
    suspend fun sendPcm(bytes: ByteArray)        // file streaming: throttled, never drops
    suspend fun sendPcm(samples: ShortArray)
    suspend fun finish()                         // sends `end`; the tail and `done` follow
    fun requestFinalize()                        // sends `finalize`; audio may continue
    fun cancel()

    companion object {
        const val DEFAULT_RELAY_URL = "wss://api.parley.tw/stt/v2/stream"
        const val CLOSED_FINISHED = "finished"
        const val SOURCE = "mix"
        const val MAX_QUEUED_BYTES = 1L * 1024 * 1024
        const val MAX_QUEUED_CHUNKS = 512        // ≈ 51 s of 100 ms chunks
    }
}
```

**One session per instance.** After a terminal event the client is spent;
`open()`/`connect()` a second time throws `IllegalStateException`.

- `idPrefix` / `timeOffsetMs` exist for a recording that reopens the relay
  mid-meeting. The service numbers every session's segments from zero and times them
  from zero, so each new leg needs its own id stem (`mix@1`, `mix@2`, …) or it
  overwrites the opening of the meeting, and an offset or its segments land at
  the start of the recording. Take the offset from `RelayAudioBridge.attach`
  (below), never from the wall clock.
- `open()` opens the socket and returns without waiting for the handshake;
  `awaitOpen()` waits for it. Audio may be enqueued **before** `open()`: the
  outbound queue exists from construction and OkHttp writes the `start` frame
  first, which is what lets the microphone start before the socket is up.
- `connect()` opens the socket (`Authorization: Bearer <token>`,
  `?feature=<tag>`), sends the `start` frame, and starts the 2 s keepalive. It
  suspends until the server's `ready` (the session is live) or a terminal event.
  **A rejected handshake is not thrown** — like every other failure it arrives on
  `events`, so there is one place to watch. Only a malformed `relayUrl` throws
  (`IllegalArgumentException`). A `relayUrl` still on the v1 path
  (`…/stt/stream`) is moved to `…/stt/v2/stream`.
- `enqueuePcm(...)` is the live-capture entry point: it drops the chunk into a
  bounded, **drop-oldest** queue that one writer coroutine drains, and never
  suspends, blocks or throws. A stalled socket costs live transcript
  (`droppedPcmChunks` counts it), never the microphone. A no-op after the
  session ends — which is why a live recording goes through
  `RelayAudioBridge` rather than calling it directly.
- `sendPcm(...)` sends one binary frame of **16 kHz mono s16le** PCM. It
  **suspends while more than 1 MB sits unsent** in OkHttp's write queue, which is
  what lets a file decoder run flat out without buffering the whole file. A no-op
  after the session ends.
- `finish()` flushes queued audio, sends `{"type":"end"}` and **deliberately
  leaves the socket open** — the service finalizes, streams the flushed tail
  back, sends `done` and closes with 1000; closing here truncates the last
  utterance. Idempotent.
- `requestFinalize()` sends `{"type":"finalize"}`: everything so far comes back
  final, then `finalized` closes the open utterance. Audio may keep flowing.
- `cancel()` is the hard teardown (abort / app shutdown): closes with 1000 and
  completes `events`. Always call it if you did not reach a terminal event.

`feature` is billing attribution (parley-internal#29). The relay only records
`meeting`, `voice_typing`, `realtime`; anything else is stored unattributed.
Voice typing sends `voice_typing` on every platform — iOS
`DictationCoordinator`, the desktop's voice-typing session, and Android's
keyboard (`ime/DictationSession`, `Feature.VOICE_TYPING`).

### `SttRelayEvent`

```kotlin
sealed interface SttRelayEvent {
    data class Segment(val segment: TranscriptSegment) : SttRelayEvent
    data class Closed(val reason: String) : SttRelayEvent
    data class Error(val message: String, val httpStatus: Int? = null) : SttRelayEvent
    data class QuotaExceeded(val message: String) : SttRelayEvent
}
```

`events` is a **single-consumer** `Flow` backed by an unbounded channel: nothing
is dropped if collection starts after `connect()`, and the flow **completes**
after the one terminal event (`Closed` / `Error` / `QuotaExceeded`) — so a
`collect { }` loop ends by itself.

| Wire condition | Event |
| --- | --- |
| `ready` | none — `awaitOpen()` / `connect()` resolve |
| `transcript` | `Segment` (committed run, then the tail — possibly empty; `tokens: []` clears the tail) |
| `endpoint` / `finalized` | none — the open run closes; the next final text gets a new id |
| `done` | `Closed("finished")` |
| recognizer unreachable (upgrade succeeds, no `ready`) | `Error("relay error upstream_unavailable: …")` |
| no `done` within 10 s of `end` | `Error("relay error upstream_unavailable: …")` — the final text already received stands |
| server close frame | `Closed("close code=<code> <reason>")` |
| `error` frame | `Error("relay error <code>: <message>")` |
| transport died mid-stream | `Closed("close code=0 <cause>")` |
| handshake rejected (401/426/429/…) | `Error("relay handshake failed: HTTP <code> <msg>", httpStatus = <code>)` |
| out of hosted STT quota | `QuotaExceeded(...)` |

`QuotaExceeded` is the one behavioral addition over the Swift client (OkHttp
exposes the handshake response that `URLSessionWebSocketTask` hid). It replaces
`Error`/`Closed` for exactly three conditions, so the UI can route to an upgrade
prompt instead of a generic failure:

- HTTP **402** on the handshake (the service's `{"error":"quota_exhausted"}`),
- an `error` frame with code **`quota_exceeded`** (per-session cap or account quota),
- close code **4402** when that frame itself never arrived.

`Error.httpStatus` is the second, smaller addition: a rejected handshake carries
the status the relay answered with, so a caller can tell a dead session
(`isUnauthorized`, HTTP 401 — send the user back to sign in) from a wait (429)
without parsing the message. It is null for an in-band `error` frame, whose code
(`bad_request`, `idle_timeout`, `upstream_unavailable`, `internal`) describes the
stream rather than the caller's sign-in.

### (a) Live mic streaming

The microphone talks to a `RelayAudioBridge`, never to a client: the bridge is
what survives a dropped socket. This is the shape `MeetingSession` uses.

```kotlin
val bridge = RelayAudioBridge()
var leg = 0

fun newLeg(offsetMs: Long): SttRelayClient = SttRelayClient(
    SttRelayClient.Options(
        bearerToken = token,
        feature = SttRelayClient.Feature.MEETING,
        idPrefix = if (leg == 0) null else "${SttRelayClient.SOURCE}@$leg",
        timeOffsetMs = offsetMs,
    )
)

fun watch(client: SttRelayClient) = scope.launch {
    client.events.collect { event ->
        when (event) {
            is SttRelayEvent.Segment -> upsert(event.segment)   // keyed by segment.id
            is SttRelayEvent.Closed, is SttRelayEvent.Error -> {
                bridge.hold()        // from now on the mic's audio waits for the next leg
                delay(backoff)
                leg += 1
                bridge.attach { offsetMs -> newLeg(offsetMs) }  // gap flushed in first
                    ?.also { watch(it); it.open() }
            }
            is SttRelayEvent.QuotaExceeded -> bridge.discard()  // no leg is coming
        }
    }
}

val first = newLeg(0)
bridge.attach { first }              // before open(): the client queues until the upgrade
watch(first)
first.open()

// MicCapture emits 100 ms chunks of 16 kHz mono s16le.
mic.start().collect { chunk -> encoder.append(chunk); bridge.send(chunk) }

bridge.discard()
current.finish()    // socket stays open; the tail is still coming
```

### (b) File streaming (faster than realtime)

Backpressure is already handled — just push as fast as the decoder produces.

```kotlin
val relay = SttRelayClient(
    SttRelayClient.Options(bearerToken = token, feature = SttRelayClient.Feature.REALTIME)
)
val collector = scope.launch { relay.events.collect(::handle) }
relay.connect()

decodeTo16kMonoPcm(uri) { chunk: ByteArray ->   // MediaCodec/MediaExtractor output
    relay.sendPcm(chunk)                        // suspends past 1 MB in flight
}

relay.finish()
collector.join()
```

Bytes must be **little-endian s16le**; use `ParleyStreamProtocol.pcmToLeBytes(...)` if
you hold `ShortArray`s, or `sendPcm(ShortArray)` which does it for you. Do not
throttle to wall-clock — the relay meters forwarded bytes, not elapsed time.

---

## `RelayAudioBridge`

```kotlin
fun interface PcmSink { fun enqueuePcm(bytes: ByteArray) }   // SttRelayClient implements it

class RelayAudioBridge(
    val holdLimitMs: Long = DEFAULT_HOLD_LIMIT_MS,       // 45 000
    sampleRate: Int = ParleyStreamProtocol.SAMPLE_RATE,
) {
    fun send(chunk: ByteArray)                           // capture thread; never waits on a socket
    fun <L : PcmSink> attach(make: (timeOffsetMs: Long) -> L?): L?  // first leg: attach { leg }
    fun hold()                                           // the leg is gone; start holding
    fun discard()                                        // no leg is coming; drop, keep the clock
    fun reset()                                          // new recording; forget the clock too

    val capturedMilliseconds: Long
    val heldMilliseconds: Long
    val isHolding: Boolean
}
```

Port of iOS `ParleyKit/Sources/ParleyKit/RelayAudioBridge.swift`; the tests
(`RelayAudioBridgeTest`) are the Swift suite one-for-one plus two Android
additions, and `RelayAudioBridgeRelayTest` runs two real client legs across a
server-side close.

- **Holding.** Between `hold()` and the next `attach`, chunks are kept, bounded
  by `holdLimitMs`; overflow drops the **oldest** chunk. 45 s covers the
  reconnect ladder plus a slow handshake and still fits one client's outbound
  queue (`MAX_QUEUED_CHUNKS`), so a flush never makes the new leg drop what it
  was just handed.
- **The offset.** `attach { offsetMs -> … }` hands the factory the position of
  the **first held sample** — or the live position when nothing is held — in
  captured audio, not wall-clock time. That is where the new leg's first word
  was actually said, and it stays aligned with the recording even when the
  microphone itself paused. Dropping from the front moves it forward with the
  buffer.
- **The flush.** Held chunks go into the new leg before any live audio.
  Unlike the Swift original, live chunks that arrive *during* the flush are
  queued behind it and the leg only starts receiving directly once the hold
  buffer is empty, so nothing can overtake the tail of the gap. Returning null
  from the factory leaves the bridge holding with nothing lost.
- **Threads.** One producer calls `send`; the lifecycle calls may come from any
  thread. The lock is never held across a flush or a socket call.
- `attach` has exactly one signature, the leg factory; the first leg is
  attached as `attach { leg }`. That is what makes `PcmSink` safe as a
  `fun interface`: with no `attach(leg: PcmSink)` overload beside it, a lambda
  passed to `attach` can never be SAM-converted into a sink by accident.

---

## `ParleyStreamProtocol`

Parley's hosted stream protocol, v2. Useful directly only if you are building
frames yourself; `SttRelayClient` speaks it for you.

```kotlin
object ParleyStreamProtocol {
    const val KEEPALIVE_INTERVAL_MS = 2_000L
    const val KEEPALIVE_FRAME = """{"type":"keepalive"}"""
    const val FINALIZE_FRAME = """{"type":"finalize"}"""
    const val END_FRAME = """{"type":"end"}"""
    const val SAMPLE_RATE = 16_000
    const val AUDIO_ENCODING = "pcm_s16le"
    const val CHANNELS = 1

    @Serializable data class Start(                     // first text frame
        val type: String = "start",
        val audio: Audio = Audio(),                     // {"encoding","sample_rate","channels"}
        val languages: List<String>? = null,            // omitted when null
        val diarization: Boolean = false,
        val endpointing: Boolean = true,
        val hints: Hints? = null,                       // {"terms":[...]}; omitted when null
    )
    @Serializable data class Token(
        val text: String = "",
        val startMs: Long = 0,
        val endMs: Long = 0,
        val isFinal: Boolean = false,                   // wire key `final`
        val speaker: Int? = null,                       // 1-based; only with diarization
        val language: String? = null,
        val confidence: Double? = null,
    )
    sealed interface ServerMessage {
        data class Ready(val sessionId: String?)
        data class Transcript(val tokens: List<Token>, val finalAudioMs: Long?, val totalAudioMs: Long?)
        data object Endpoint
        data object Finalized
        data object Done
        data class Error(val code: String, val message: String)
    }

    fun encodeStart(start: Start): String
    fun decode(payload: String): ServerMessage?         // null = unparseable or unknown type, skip it
    fun pcmToLeBytes(samples: ShortArray): ByteArray
}

class ParleyStreamError(val code: String, override val message: String) : Exception()
```

All JSON keys are snake_case on the wire (`sample_rate`, `start_ms`,
`session_id`, …). Only `pcm_s16le` / 16 000 Hz / mono is accepted; anything else
is an `error` with code `bad_request`. Error codes and their close codes:
`bad_request` 4400, `quota_exceeded` 4402, `idle_timeout` 4408,
`upstream_unavailable` 1011, `internal` 1011.

---

## `ParleyStreamParser`

```kotlin
class ParleyStreamParser(
    source: String = "mix",
    idPrefix: String = source,
    timeOffsetMs: Long = 0,
    sink: (TranscriptSegment) -> Unit,
) {
    val ready: Boolean
    val sessionId: String?
    val finished: Boolean
    @Throws(ParleyStreamError::class) fun process(payload: String): ParleyStreamProtocol.ServerMessage?
}
```

One raw server text frame in, segments out through `sink`. Throws
`ParleyStreamError` on an `error` frame (the stream is dead from that point);
unparseable frames and unknown types are skipped (returns null). `SttRelayClient`
drives this for you — use it directly only for offline replay of captured frames.

Per `transcript` frame: every final token is pushed to the builder, the
non-final tokens are concatenated into one tail, then `emitCommitted()` →
`emitTail(...)`. `endpoint` and `finalized` call `endpoint()`; `done` sets
`finished`; `ready` sets `ready`/`sessionId`.

---

## `SegmentBuilder`

```kotlin
class SegmentBuilder(source: String, sink: (TranscriptSegment) -> Unit) {
    val currentSpeaker: Int    // 0 when no run is open
    val currentEnd: Long
    fun pushFinal(text: String, speaker: Int, startMs: Long, endMs: Long)
    fun emitCommitted()
    fun emitTail(text: String, speaker: Int, startMs: Long)
    fun endpoint()
}
```

Accumulates finalized tokens into speaker-runs. A speaker change closes the open
run (emitting it solid) and starts a new one; **speaker 0 never splits**, because
non-diarizing input always reports 0. A blank (whitespace-only) run never
commits, and an `endpoint()` on an empty run does not advance the index.

Neither `SegmentBuilder` nor `ParleyStreamParser` is thread-safe — drive each
from one thread. `SttRelayClient` drives them from the single WebSocket reader
thread and hands you finished segments on the flow.

---

## Not in this module

- **Audio capture and Opus encoding.** iOS's `OggOpusEncoder` (AudioToolbox)
  has no pure-JVM equivalent; Android uses `MediaCodec` (hence `minSdk 29`),
  which lives in `:app`. The Ogg *container* is hand-written and pure JVM, but
  it sits next to the encoder in `:app` (`audio/OggStreamWriter`) rather than
  here, since nothing outside the encoder has a use for it.
- **The microphone recovery this module's `CaptureRecovery` decides.** The
  policy is here because it is pure logic and the only part testable without a
  device; everything that touches `AudioRecord`, `AudioManager` or the activity
  lifecycle is in `:app` (`audio/MicCapture`).
- **Cloud REST client / DTOs** (`CloudClient`, `CloudModels`) — separate work,
  same package. It reuses `TranscriptSegment` from here.
- **Keychain / dictation IPC** — iOS-specific (`KeychainStore`,
  `DictationChannel`); Android uses DataStore and in-process state.
