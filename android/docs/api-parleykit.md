# ParleyKit (Android) — public API

`:parleykit` is a pure Kotlin/JVM module (no Android APIs) holding the transcript
core, ported line-for-line from the iOS `ParleyKit` Swift package, which was
itself a faithful port of the desktop's Rust
(`src-tauri/src/transcription/{common,soniox}.rs`). The unit tests are the
contract: if they drift, the three transcripts drift.

Package: `com.pathors.parley.kit`.

```
mic / decoded file ──16k mono s16le──▶ SttRelayClient ──▶ hosted STT relay ──▶ Soniox
                                             │
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
class SttRelayClient(options: Options) {
    data class Options(
        val bearerToken: String,
        val relayUrl: String = DEFAULT_RELAY_URL,       // "wss://api.parley.tw/stt/stream"
        val model: String = DEFAULT_MODEL,              // "stt-rt-v5" (advisory; relay forces it)
        val languageHints: List<String>? = null,        // e.g. listOf("zh", "en")
        val feature: String = Feature.MEETING,
    )

    object Feature {
        const val MEETING = "meeting"
        const val VOICE_TYPING = "voice_typing"
        const val REALTIME = "realtime"
    }

    val events: Flow<SttRelayEvent>
    val isTerminated: Boolean

    suspend fun connect()
    suspend fun sendPcm(bytes: ByteArray)
    suspend fun sendPcm(samples: ShortArray)
    suspend fun finish()
    fun cancel()

    companion object {
        const val DEFAULT_RELAY_URL = "wss://api.parley.tw/stt/stream"
        const val DEFAULT_MODEL = "stt-rt-v5"
        const val SOURCE = "mix"
        const val MAX_QUEUED_BYTES = 1L * 1024 * 1024
    }
}
```

**One session per instance.** After a terminal event the client is spent;
`connect()` a second time throws `IllegalStateException`.

- `connect()` opens the socket (`Authorization: Bearer <token>`,
  `?feature=<tag>`), sends the keyless Soniox config frame, and starts the 2 s
  keepalive. It suspends until the handshake resolves. **A rejected handshake is
  not thrown** — like every other failure it arrives on `events`, so there is one
  place to watch. Only a malformed `relayUrl` throws (`IllegalArgumentException`).
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

```kotlin
val relay = SttRelayClient(
    SttRelayClient.Options(bearerToken = token, feature = SttRelayClient.Feature.MEETING)
)

// Collect first — connect() does not wait for the stream to start.
val collector = scope.launch {
    relay.events.collect { event ->
        when (event) {
            is SttRelayEvent.Segment -> upsert(event.segment)   // keyed by segment.id
            is SttRelayEvent.Closed -> onStopped(event.reason)
            is SttRelayEvent.Error -> onFailed(event.message)
            is SttRelayEvent.QuotaExceeded -> showUpgradePrompt(event.message)
        }
    }
}

relay.connect()

// AudioRecord at 16 kHz / MONO / ENCODING_PCM_16BIT.
val buffer = ShortArray(1600)   // 100 ms
while (recording) {
    val n = audioRecord.read(buffer, 0, buffer.size)
    if (n > 0) relay.sendPcm(buffer.copyOf(n))
}

relay.finish()      // socket stays open; the tail is still coming
collector.join()    // flow completes on the relay's close
```

`AudioRecord.read(ShortArray, …)` is blocking, so run the loop on
`Dispatchers.IO`.

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

- **Audio capture and Ogg/Opus encoding.** iOS's `OggOpusEncoder` (AudioToolbox)
  has no pure-JVM equivalent; Android uses `MediaCodec` + `MediaMuxer` (hence
  `minSdk 29`), which lives in `:app`.
- **Cloud REST client / DTOs** (`CloudClient`, `CloudModels`) — separate work,
  same package. It reuses `TranscriptSegment` from here.
- **Keychain / dictation IPC** — iOS-specific (`KeychainStore`,
  `DictationChannel`); Android uses DataStore and in-process state.
