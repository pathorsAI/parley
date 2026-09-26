# ParleyKit (Android) — public API

`:parleykit` is a pure Kotlin/JVM module (no Android APIs) holding the transcript
core, ported line-for-line from the iOS `ParleyKit` Swift package, which was
itself a faithful port of the desktop's Rust
(`src-tauri/src/transcription/{common,soniox}.rs`). The unit tests are the
contract: if they drift, the three transcripts drift.

Package: `com.pathors.parley.kit`.

```
mic ──16k mono s16le──▶ RelayAudioBridge ──▶ SttRelayClient (leg N) ──▶ hosted STT relay ──▶ Soniox
decoded file ─────────────────────────────▶ SttRelayClient          │
                                                                    SonioxStreamParser
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
        val relayUrl: String = DEFAULT_RELAY_URL,       // "wss://api.parley.tw/stt/stream"
        val model: String = DEFAULT_MODEL,              // "stt-rt-v5" (advisory; relay forces it)
        val languageHints: List<String>? = null,        // e.g. listOf("zh", "en")
        val feature: String = Feature.MEETING,
        val idPrefix: String? = null,                   // segment id stem; default "mix"
        val timeOffsetMs: Long = 0,                     // added to every emitted timestamp
    )

    object Feature {
        const val MEETING = "meeting"
        const val VOICE_TYPING = "voice_typing"
        const val REALTIME = "realtime"
    }

    val events: Flow<SttRelayEvent>
    val isTerminated: Boolean
    val droppedPcmChunks: Long

    fun open()                                   // returns at once; handshake in flight
    suspend fun awaitOpen()                      // resolves on open *or* on a rejected handshake
    suspend fun connect()                        // open() + awaitOpen()
    override fun enqueuePcm(bytes: ByteArray)    // live capture: never waits, drop-oldest
    fun enqueuePcm(samples: ShortArray)
    suspend fun sendPcm(bytes: ByteArray)        // file streaming: throttled, never drops
    suspend fun sendPcm(samples: ShortArray)
    suspend fun finish()
    fun cancel()

    companion object {
        const val DEFAULT_RELAY_URL = "wss://api.parley.tw/stt/stream"
        const val DEFAULT_MODEL = "stt-rt-v5"
        const val SOURCE = "mix"
        const val MAX_QUEUED_BYTES = 1L * 1024 * 1024
        const val MAX_QUEUED_CHUNKS = 512        // ≈ 51 s of 100 ms chunks
    }
}
```

**One session per instance.** After a terminal event the client is spent;
`open()`/`connect()` a second time throws `IllegalStateException`.

- `idPrefix` / `timeOffsetMs` exist for a recording that reopens the relay
  mid-meeting. Soniox numbers every session's segments from zero and times them
  from zero, so each new leg needs its own id stem (`mix@1`, `mix@2`, …) or it
  overwrites the opening of the meeting, and an offset or its segments land at
  the start of the recording. Take the offset from `RelayAudioBridge.attach`
  (below), never from the wall clock.
- `open()` opens the socket and returns without waiting for the handshake;
  `awaitOpen()` waits for it. Audio may be enqueued **before** `open()`: the
  outbound queue exists from construction and OkHttp writes the config frame
  first, which is what lets the microphone start before the socket is up.
- `connect()` opens the socket (`Authorization: Bearer <token>`,
  `?feature=<tag>`), sends the keyless Soniox config frame, and starts the 2 s
  keepalive. It suspends until the handshake resolves. **A rejected handshake is
  not thrown** — like every other failure it arrives on `events`, so there is one
  place to watch. Only a malformed `relayUrl` throws (`IllegalArgumentException`).
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
- `finish()` sends `{"type":"finalize"}` and **deliberately leaves the socket
  open** — the relay has to forward the finalize to Soniox and stream the flushed
  tail back; closing here truncates the last utterance. The relay closes once
  Soniox is done. Idempotent.
- `cancel()` is the hard teardown (abort / app shutdown): closes with 1000 and
  completes `events`. Always call it if you did not reach a terminal event.

`feature` is billing attribution (parley-internal#29). The relay only records
`meeting`, `voice_typing`, `realtime`; anything else is stored unattributed. (iOS
passes `"dictation"` for the keyboard, which the relay does *not* recognize — use
`Feature.VOICE_TYPING` on Android.)

### `SttRelayEvent`

```kotlin
sealed interface SttRelayEvent {
    data class Segment(val segment: TranscriptSegment) : SttRelayEvent
    data class Closed(val reason: String) : SttRelayEvent
    data class Error(val message: String) : SttRelayEvent
    data class QuotaExceeded(val message: String) : SttRelayEvent
}
```

`events` is a **single-consumer** `Flow` backed by an unbounded channel: nothing
is dropped if collection starts after `connect()`, and the flow **completes**
after the one terminal event (`Closed` / `Error` / `QuotaExceeded`) — so a
`collect { }` loop ends by itself.

| Wire condition | Event |
| --- | --- |
| token frame | `Segment` (committed run, then the tail — possibly empty) |
| Soniox `finished` marker | `Closed("finished")` |
| server close frame | `Closed("close code=<code> <reason>")` |
| in-band `error_code` | `Error("relay error <code>: <message>")` |
| transport died mid-stream | `Closed("close code=0 <cause>")` |
| handshake rejected (401/429/…) | `Error("relay handshake failed: HTTP <code> <msg>")` |
| out of hosted STT quota | `QuotaExceeded(...)` |

`QuotaExceeded` is the one behavioral addition over the Swift client (OkHttp
exposes the handshake response that `URLSessionWebSocketTask` hid). It replaces
`Error`/`Closed` for exactly three conditions, so the UI can route to an upgrade
prompt instead of a generic failure:

- HTTP **402** on the handshake (the relay's `{"error":"quota_exhausted"}`),
- in-band `error_code` **402**,
- the relay's mid-session hard cut: close **1011** with `"quota"` in the reason.

Message strings are otherwise byte-identical to the Swift client's.

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
bridge.attach(first)                 // before open(): the client queues until the upgrade
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

Bytes must be **little-endian s16le**; use `SonioxProtocol.pcmToLeBytes(...)` if
you hold `ShortArray`s, or `sendPcm(ShortArray)` which does it for you. Do not
throttle to wall-clock — the relay meters forwarded bytes, not elapsed time.

---

## `RelayAudioBridge`

```kotlin
interface PcmSink { fun enqueuePcm(bytes: ByteArray) }   // SttRelayClient implements it

class RelayAudioBridge(
    val holdLimitMs: Long = DEFAULT_HOLD_LIMIT_MS,       // 45 000
    sampleRate: Int = SonioxProtocol.SAMPLE_RATE,
) {
    fun send(chunk: ByteArray)                           // capture thread; never waits on a socket
    fun attach(leg: PcmSink)                             // first leg, nothing held
    fun <L : PcmSink> attach(make: (timeOffsetMs: Long) -> L?): L?
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
- `PcmSink` is a plain interface, not a `fun interface`, so a lambda passed to
  `attach` cannot be SAM-converted into a sink by accident.

---

## `SonioxProtocol`

The Soniox realtime wire protocol as spoken through the relay (a byte-for-byte
passthrough downstream; it injects the vendor key and forces the model upstream).
Useful directly only if you are building frames yourself.

```kotlin
object SonioxProtocol {
    const val TOKEN_END = "<end>"                       // closes an utterance
    const val TOKEN_FIN = "<fin>"                       // last token of the stream
    const val KEEPALIVE_INTERVAL_MS = 2_000L
    const val KEEPALIVE_FRAME = """{"type":"keepalive"}"""
    const val FINALIZE_FRAME = """{"type":"finalize"}"""
    const val SAMPLE_RATE = 16_000
    const val AUDIO_FORMAT = "pcm_s16le"

    @Serializable data class Config(
        val apiKey: String? = null,                     // null in relay mode — omitted from JSON
        val model: String,
        val audioFormat: String = AUDIO_FORMAT,
        val sampleRate: Int = SAMPLE_RATE,
        val numChannels: Int = 1,
        val languageHints: List<String>? = null,
        val enableEndpointDetection: Boolean = true,
        val enableSpeakerDiarization: Boolean = true,
    )
    @Serializable data class Token(
        val text: String = "",
        val isFinal: Boolean = false,
        val startMs: Long = 0,
        val endMs: Long = 0,
        val speaker: String = "",                       // Soniox sends a STRING ("1"), or omits it
    )
    @Serializable data class Response(
        val tokens: List<Token> = emptyList(),
        val errorCode: Int? = null,
        val errorMessage: String? = null,
        val finished: Boolean = false,
    )

    fun encodeConfig(config: Config): String
    fun decodeResponse(payload: String): Response?      // null = unparseable, skip the frame
    fun pcmToLeBytes(samples: ShortArray): ByteArray
}

class SonioxStreamError(val code: Int, override val message: String) : Exception()
```

All JSON keys are snake_case on the wire (`api_key`, `is_final`, `start_ms`, …).
Null `apiKey` / `languageHints` are **omitted**, not sent as `null` — relay mode
must not carry an `api_key` field at all.

---

## `SonioxStreamParser`

```kotlin
class SonioxStreamParser(source: String = "mix", sink: (TranscriptSegment) -> Unit) {
    val finished: Boolean
    @Throws(SonioxStreamError::class) fun process(payload: String)
}
```

One raw downstream text frame in, segments out through `sink`. Throws
`SonioxStreamError` on an in-band error frame (the stream is dead from that
point); unparseable frames are silently skipped. `SttRelayClient` drives this for
you — use it directly only for offline replay of captured frames.

Per frame, in order: every final token is pushed to the builder, the interim
tokens are concatenated into one tail, then `emitCommitted()` → `emitTail(...)` →
`endpoint()` if an `<end>`/`<fin>` marker appeared.

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

Neither `SegmentBuilder` nor `SonioxStreamParser` is thread-safe — drive each
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
