# Audio layer API — `com.pathors.parley.audio`

Everything in the app speaks one internal format: **16 kHz mono s16le PCM**
(`Pcm.SAMPLE_RATE`, little-endian signed 16-bit). It is what the desktop app
produces, what iOS produces, and what the relay meters at 32 000 bytes/s. Three
public entry points, one shared converter:

| Type | Direction | Use it for |
|---|---|---|
| `MicCapture` | mic → `Flow<ByteArray>` | live recording |
| `AudioFileDecoder` | any audio file → `Flow<ByteArray>` | importing a file |
| `OggOpusEncoder` | `ByteArray` chunks → `.ogg` file | persisting a recording |
| `Resampler` / `Pcm` | building blocks | anything custom |

No new dependencies: `MediaCodec`, `MediaExtractor`, `MediaMuxer`, `AudioRecord`
and coroutines only.

---

## `Pcm` — constants and byte helpers

```kotlin
Pcm.SAMPLE_RATE        // 16_000
Pcm.BYTES_PER_SAMPLE   // 2
Pcm.BYTES_PER_SECOND   // 32_000
Pcm.CHUNK_MILLIS       // 100
Pcm.CHUNK_BYTES        // 3_200  (one emission from MicCapture / AudioFileDecoder)

Pcm.rmsFromS16le(bytes): Float           // 0..1, for a level meter
Pcm.floatToS16le(samples): ByteArray     // clamped, little-endian
Pcm.s16leToFloat(bytes, off, len, out): Int
Pcm.downmixToMono(interleaved, frames, channels, out)
```

Duration of a PCM buffer: `bytes.size * 1000L / Pcm.BYTES_PER_SECOND` ms.

---

## `MicCapture` — live microphone

```kotlin
class MicCapture(context: Context, chunkBytes: Int = Pcm.CHUNK_BYTES) {
    val level: StateFlow<Float>       // RMS of the last chunk, 0..1
    val captureSampleRate: Int        // what the device actually opened
    val captureSource: Int            // MediaRecorder.AudioSource actually used
    fun start(): Flow<ByteArray>      // 16 kHz mono s16le, 3200 bytes per emission
    fun stop()
}
```

```kotlin
val mic = MicCapture(context)
val job = scope.launch(Dispatchers.IO) {
    mic.start()
        .catch { e -> ui.showError(e as MicCaptureException) }
        .collect { chunk ->
            relay.send(chunk)      // websocket
            encoder.append(chunk)  // OggOpusEncoder
        }
}
// stop the recording (flow completes normally, device released):
mic.stop()          // …or job.cancel(), both are safe
```

* **Cold flow** — recording starts on collection. Collect it once at a time.
* **Permission** — `RECORD_AUDIO` must already be granted; the flow fails with
  `MicCaptureException.PermissionDenied` otherwise. Recording in the background
  needs the existing `MeetingService` foreground service
  (`foregroundServiceType="microphone"`); start the service *before* collecting.
* **Threading** — reads happen on a dedicated `THREAD_PRIORITY_URGENT_AUDIO`
  thread and arrive through a 64-chunk channel (≈ 6.4 s of slack). Collect on
  `Dispatchers.IO` (or any non-main dispatcher) and keep the collector cheap; a
  stalled collector back-pressures the reader rather than growing memory.
* **Source** — `VOICE_RECOGNITION`, falling back to `MIC`. `captureSource` says
  which one you got.
* **Rate** — 16 kHz is requested (CDD-mandated). If a device refuses it we open
  48 kHz or 44.1 kHz and resample in the read loop; callers always see 16 kHz.
* **`level`** — drive a meter off this; it resets to 0 when capture ends.

### Errors (`MicCaptureException`, delivered through the flow)

| Subclass | When |
|---|---|
| `PermissionDenied` | `RECORD_AUDIO` not granted at `start()` |
| `DeviceUnavailable` | mic busy, in a call, or `startRecording()` refused |
| `UnsupportedConfiguration` | no sample rate / source combination worked |
| `ReadFailed(errorCode)` | device died or permission revoked mid-stream |

Not detectable here: from Android 10 on, an app that takes the mic away
mid-recording makes the framework feed us **silence** instead of an error. The
`level` meter reveals it to the user; if you want to react programmatically,
register an `AudioManager.AudioRecordingCallback` in the service layer.

---

## `AudioFileDecoder` — import any audio file

```kotlin
object AudioFileDecoder {
    suspend fun probe(context: Context, uri: Uri): AudioSourceInfo
    fun decode(context: Context, uri: Uri, quality = BALANCED): Flow<ByteArray>
    fun decodeWithProgress(context: Context, uri: Uri, quality = BALANCED): Flow<DecodeEvent>
}

data class AudioSourceInfo(
    val mimeType: String,
    val sampleRate: Int,
    val channelCount: Int,
    val durationUs: Long,      // -1 when the container does not say
) {
    val durationMs: Long
    val estimatedPcmBytes: Long
}

sealed interface DecodeEvent {
    data class Started(val info: AudioSourceInfo)
    data class Chunk(val pcm: ByteArray, val bytesDecoded: Long, val estimatedTotalBytes: Long) {
        val progress: Float    // 0..1, or -1f when the duration is unknown
        val positionUs: Long
    }
    data class Completed(val totalBytes: Long, val durationUs: Long, val decodedDurationUs: Long)
}
```

```kotlin
// stream to the relay while still decoding, with a progress bar
AudioFileDecoder.decodeWithProgress(context, uri)
    .collect { event ->
        when (event) {
            is DecodeEvent.Started   -> ui.duration(event.info.durationMs)
            is DecodeEvent.Chunk     -> { relay.send(event.pcm); ui.progress(event.progress) }
            is DecodeEvent.Completed -> ui.finished(event.decodedDurationUs / 1000)
        }
    }
```

* **Formats** — whatever `MediaExtractor`/`MediaCodec` support: mp3, m4a/aac,
  wav, flac, ogg/vorbis, ogg/opus, webm/opus, 3gp, and the audio track of an mp4
  video. `audio/raw` (WAV) skips `MediaCodec` and is read straight off the
  extractor.
* **Output** — `Pcm.CHUNK_BYTES` per chunk except the last.
* **Duration** — `Started.info.durationUs` is the container's claim (or -1);
  `Completed.decodedDurationUs` is what we actually produced and is
  authoritative. Use `probe()` when you only need duration for the UI.
* **Threading** — runs on `Dispatchers.IO`. Cold and back-pressured: a slow
  collector suspends the decoder instead of buffering the file. Cancelling the
  collector releases the codec immediately.
* **Quality** — `Resampler.Quality.BALANCED` by default (see below). `FAST`
  halves the CPU if you are ever decoding on a very slow device.

### Errors (`AudioDecodeException`)

| Subclass | When |
|---|---|
| `SourceUnreadable(uri)` | URI cannot be opened, or is not a media container |
| `NoAudioTrack(uri)` | parsed, but no audio track (e.g. a silent video) |
| `UnsupportedCodec(mimeType)` | audio track exists, no decoder on this device |
| `DecodeFailed(message)` | decoder failed or stalled part-way |

---

## `OggOpusEncoder` — persist a recording

```kotlin
class OggOpusEncoder {
    companion object {
        const val DEFAULT_BITRATE = 24_000
        fun create(outputFile: File, bitrate: Int = DEFAULT_BITRATE): OggOpusEncoder
        suspend fun encode(source: Flow<ByteArray>, outputFile: File, bitrate: Int = DEFAULT_BITRATE): File
    }
    val durationMs: Long
    val file: File
    fun append(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset)
    fun finish(): File
    fun cancel()
}
```

```kotlin
// live: encode while recording
val encoder = OggOpusEncoder.create(File(context.filesDir, "meetings/$id.ogg"))
mic.start().collect { encoder.append(it) }        // background dispatcher!
val recording = encoder.finish()

// bulk: encode an import in one line
val recording = OggOpusEncoder.encode(AudioFileDecoder.decode(context, uri), outFile)
```

* **Settings** — 16 kHz mono, 24 000 bps, 20 ms frames: the same as the desktop
  encoder in `src-tauri/src/replay_audio.rs`. The only setting `MediaCodec` does
  not expose is libopus' `Application::VOIP`; at 24 kbps mono speech that is
  inaudible and irrelevant to transcription. Roughly 3 MB per hour.
* **Chunking** — `append` takes any length; frames are assembled internally, so
  mic chunks and decoder chunks can be handed over as-is.
* **Threading** — all methods block on `MediaCodec`; call them off the main
  thread. They are `synchronized`, so appending from the capture coroutine and
  calling `finish()` from elsewhere is safe.
* **Lifecycle** — exactly one `finish()` (or `cancel()`). On failure `finish()`
  releases everything and deletes the partial file. An encoder that received no
  audio writes 20 ms of silence so the file is always a valid container.

### Errors (`OpusEncodeException`)

| Subclass | When |
|---|---|
| `EncoderUnavailable` | no Opus encoder on the device, or it refused the format |
| `MuxerFailed` | output file cannot be written / finalised |
| `EncodeFailed` | encoder stalled or errored mid-stream |

`EncoderUnavailable` is the one worth handling in the UI: fall back to uploading
the raw PCM (the relay accepts it) rather than failing the recording.

---

## `Resampler` — the shared converter

```kotlin
class Resampler(inputRate: Int, outputRate: Int = Pcm.SAMPLE_RATE, quality: Quality = BALANCED) {
    enum class Quality { FAST, BALANCED, HIGH }
    val isPassthrough: Boolean
    fun process(input: FloatArray, count: Int = input.size): FloatArray
    fun flush(): FloatArray
    fun reset()
    fun expectedOutputCount(inputSamples: Long): Long
}
```

Windowed-sinc band-limited interpolation (Kaiser-windowed, ≈ −80 dB stopband),
not linear interpolation: a 44.1 kHz source has content up to 22 kHz and every
bit of it above 8 kHz would otherwise fold into the speech band. Streaming-safe
— chunk boundaries do not affect the result — and pure Kotlin, so it is unit
tested (`app/src/test/kotlin/.../ResamplerTest.kt`). Costs a few seconds of CPU
per hour of imported audio at `BALANCED`.

---

## Testing

`./gradlew :app:testDebugUnitTest` covers the resampler (tone preservation,
alias rejection, streaming vs one-shot equality, DC gain, output length), the
PCM byte conversions, the decoder's PCM sink and the synthesized `OpusHead`.

`MediaCodec`, `MediaMuxer` and `AudioRecord` cannot run on the JVM, so those
paths are written defensively and verified by hand. Manual checklist:

1. **Mic** — record 30 s, confirm the file plays back and `level` tracks speech.
2. **Mic while busy** — start a phone call, then start recording: expect
   `DeviceUnavailable`, not a crash.
3. **Permission** — revoke `RECORD_AUDIO` in Settings mid-recording: expect
   `ReadFailed` or a process kill, never a silent hang.
4. **Import** — decode one file per format (mp3, m4a, wav, flac, ogg/vorbis,
   ogg/opus, an mp4 video) and check `Completed.decodedDurationUs` matches the
   real duration to within a few ms.
5. **Import, odd rates** — a 44.1 kHz and a 8 kHz file, to exercise both
   downsample and upsample.
6. **No audio track** — pick a video with no audio: expect `NoAudioTrack`.
7. **Encode** — pull the `.ogg` off the device and check with
   `ffprobe -show_entries stream=codec_name,channels,duration`: `opus`,
   `channels=1`, duration matching the recording. `ffmpeg -v error -i f.ogg -f
   null -` must print nothing.
8. **Encode, bulk** — import a 1 h file and confirm the output is ~3 MB/h and
   the duration is right end to end.
9. **Cancel** — cancel an import mid-way: no leaked codec (watch
   `adb shell dumpsys media.player`), no orphaned file.

### Device-compatibility caveats

* The Opus **encoder** and `MUXER_OUTPUT_OGG` both arrived in API 29, which is
  our `minSdk` — but a handful of heavily customised builds ship without the
  encoder. `OpusEncodeException.EncoderUnavailable` is the signal; keep the
  raw-PCM upload path working.
* Some encoders report the Opus CSD (`csd-0/1/2`) only through
  `INFO_OUTPUT_FORMAT_CHANGED`, some as `BUFFER_FLAG_CODEC_CONFIG` buffers.
  Both are handled, and missing headers are synthesized — but if a device
  produces an `.ogg` that players reject, that is the first place to look.
* `VOICE_RECOGNITION` is unavailable on a few devices (and on some it silently
  behaves like `MIC` with AGC on). Check `captureSource` when audio quality
  looks off on a specific model.
* Decoding ogg/opus and flac depends on the device's software codecs. They are
  part of the standard AOSP set; a stripped build surfaces as
  `UnsupportedCodec`.
