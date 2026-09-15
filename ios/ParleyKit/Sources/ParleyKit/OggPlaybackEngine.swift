import AVFoundation
import AudioToolbox
import Foundation

public enum OggPlaybackError: Error, Equatable {
    /// AudioToolbox could not open the file, or could not be persuaded to hand
    /// back 16 kHz mono float.
    case unreadable(String)
    /// The file opened but has no length worth playing.
    case empty
    /// `AVAudioEngine` refused to start, or refused a render.
    case engine(String)
    /// An offline-only call on a real-time engine, or the other way round.
    case wrongMode
}

/// One Ogg/Opus recording, decoded and played through an `AVAudioEngine` graph.
///
/// ## Why this exists rather than `AVAudioPlayer`
///
/// `AVAudioPlayer` opens a 16 kHz Ogg/Opus recording, reports the right
/// duration and plays it — but it **cannot seek inside one**. Assigning
/// `currentTime` moves the number the player reports back and nothing else;
/// decoding carries on from wherever it was. Measured on a 74-minute recording
/// with metering on: the file is −41.9 dB at 0–3 s and −15.7 dB at 2932 s, and
/// `AVAudioPlayer` put out −54.3 dB before `currentTime = 2932` and −53.3 dB
/// after it, while cheerfully reporting 2934.6 s. The clock was the only thing
/// that moved. Every simulator check passed for two releases because they all
/// read `currentTime` back, which is precisely the value that lies.
///
/// `ExtAudioFileSeek` on the same bytes positions correctly — it is already how
/// `AudioPeaks` reads the waveform — so the decoder stays and the player goes.
/// This type is the replacement: `ExtAudioFile` (client format Float32 mono
/// 16 kHz, so the Opus decode, the 48 kHz → 16 kHz resample and the downmix all
/// happen inside AudioToolbox) feeding an `AVAudioPlayerNode` →
/// `AVAudioUnitTimePitch` → main mixer graph. The time-pitch unit is what
/// `enableRate` used to be: 0.75–2× with the pitch left alone.
///
/// Four Ogg facts shape the code below:
///
/// - Opening is **not free**. There is no frame count in an Ogg header, so
///   AudioToolbox walks to the last page to find the length. For a long meeting
///   that is real work, which is why `PlaybackController` opens off the main
///   actor behind a `Preparing…` state.
/// - **File frames and client frames are different units, and they are three
///   apart here.** `kExtAudioFileProperty_FileLengthFrames` and the offset
///   `ExtAudioFileSeek` takes are both in the *file's* rate — 48 kHz Opus
///   granules — while every frame `ExtAudioFileRead` hands back is a 16 kHz
///   client frame. Divide the length by 16000 and a 105-second recording
///   reports as 315; seek to `time × 16000` and you land a third of the way
///   there. The second mistake is the dangerous one, because it looks like a
///   seek that works right up until you listen to it.
/// - Seeking *to* the end fails and silently leaves the reader at frame 0, so
///   the target is clamped one frame short. Otherwise dragging the scrubber to
///   the right-hand edge restarts the recording.
/// - `AVAudioFile(forReading:)` opens the same file but reports `length == 0`
///   and then throws on `read`. Do not reach for it here.
///
/// ## Threading
///
/// One serial queue owns the decoder and every scheduling decision; every
/// public command hops onto it. Buffer completions never touch that state
/// directly — they bounce back onto the queue — so nothing can be mutated from
/// the render thread. A **generation counter** rides on each scheduled buffer:
/// a completion from before a seek is a completion for audio nobody is
/// listening to any more, and is dropped.
///
/// The two numbers a UI polls (`currentTime`, `isPlaying`) live behind a small
/// lock instead, so a 10 Hz ticker never has to wait behind a file read.
public final class OggPlaybackEngine: @unchecked Sendable {

    /// Real time through the speakers, or offline into a buffer for tests.
    public enum Output {
        case realtime
        /// Manual rendering. `maximumFrameCount` is the biggest slice
        /// `renderOffline(seconds:)` will ask the engine for at once.
        case offline(maximumFrameCount: AVAudioFrameCount)
    }

    /// Everything downstream of the decoder runs at the recording's own rate,
    /// so `sampleTime` is media time and needs no conversion.
    public static let sampleRate = Double(OggOpusEncoder.sampleRate)

    /// Half a second per buffer. Small enough that a seek only has to throw
    /// away half a second of work, large enough that an hour of audio is 7,200
    /// reads rather than a stream of tiny ones.
    private static let bufferFrames: AVAudioFrameCount = 8_000
    /// How far ahead of the playhead the reader keeps the node fed. Three
    /// buffers — 1.5 s — is enough slack for a file read to land late without a
    /// gap, and short enough that a seek does not have to unwind much.
    private static let buffersAhead: Int64 = 3

    public let url: URL
    /// Length in seconds, from the file header rather than by decoding to the
    /// end. See the type doc on which sample rate that division uses.
    public let duration: TimeInterval

    /// The container's own rate — 48 kHz for Opus — and its length in those
    /// frames. Both `ExtAudioFileSeek` and
    /// `kExtAudioFileProperty_FileLengthFrames` speak this unit, never the
    /// 16 kHz client one. See `apply(seek:)`.
    private let fileSampleRate: Double
    private let fileLengthFrames: Int64

    /// Called once when the last buffer has actually been played out, on the
    /// engine's queue. The owner is expected to hop to its own actor.
    public var onFinish: (@Sendable () -> Void)? {
        get { stateLock.withLock { _onFinish } }
        set { stateLock.withLock { _onFinish = newValue } }
    }

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let format: AVAudioFormat
    private let queue = DispatchQueue(label: "com.pathors.parley.playback")
    private let isOffline: Bool

    // MARK: owned by `queue`

    private var file: ExtAudioFileRef?
    /// The buffer that has been read but not yet handed to the node. The reader
    /// always stays one buffer ahead of the scheduler so that "this is the last
    /// one" is known *before* it is scheduled — which is the only way to give
    /// the final buffer its end-of-stream completion (see `finalCallbackType`).
    private var lookahead: AVAudioPCMBuffer?
    private var primed = false
    private var readerAtEnd = false
    private var finalScheduled = false
    /// Frames handed to the node since the last seek. Compared against the
    /// node's own `sampleTime` to decide whether to read more, so the refill
    /// decision does not depend on completions arriving.
    private var scheduledFrames: AVAudioFramePosition = 0
    private var generation = 0
    private var wantsPlaying = false
    private var finished = false

    // MARK: owned by `stateLock`

    private let stateLock = NSLock()
    private var _seekBase: TimeInterval = 0
    private var _framesSinceSeek: AVAudioFramePosition = 0
    /// False between a seek being asked for and the node being repositioned. In
    /// that window the node is still rendering the *old* position, so its
    /// `sampleTime` would drag the reported clock back to where the finger just
    /// left.
    private var _positionValid = true
    private var _pendingSeek: TimeInterval?
    private var _onFinish: (@Sendable () -> Void)?

    // MARK: opening

    public init(url: URL, output: Output = .realtime) throws {
        self.url = url
        if case .offline = output { isOffline = true } else { isOffline = false }

        guard let format = AVAudioFormat(standardFormatWithSampleRate: Self.sampleRate, channels: 1)
        else {
            throw OggPlaybackError.unreadable("cannot describe 16 kHz mono float")
        }
        self.format = format

        var ref: ExtAudioFileRef?
        let opened = ExtAudioFileOpenURL(url as CFURL, &ref)
        guard opened == noErr, let file = ref else {
            throw OggPlaybackError.unreadable("ExtAudioFileOpenURL failed (\(opened))")
        }

        // Mirrors `AudioPeaks`: mono float at the recording rate, so the
        // converter does the Opus decode, the resample and the downmix and
        // everything above is one plain channel of Float32.
        var client = AudioStreamBasicDescription(
            mSampleRate: Self.sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        let configured = ExtAudioFileSetProperty(
            file, kExtAudioFileProperty_ClientDataFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client)
        guard configured == noErr else {
            ExtAudioFileDispose(file)
            throw OggPlaybackError.unreadable("client format rejected (\(configured))")
        }

        let geometry = Self.readGeometry(file: file, url: url)
        duration = geometry.seconds
        fileSampleRate = geometry.rate
        fileLengthFrames = geometry.frames
        guard duration > 0, fileSampleRate > 0 else {
            ExtAudioFileDispose(file)
            throw OggPlaybackError.empty
        }
        self.file = file

        engine.attach(playerNode)
        engine.attach(timePitch)
        engine.connect(playerNode, to: timePitch, format: format)
        engine.connect(timePitch, to: engine.mainMixerNode, format: format)
        if case .offline(let maximumFrameCount) = output {
            do {
                try engine.enableManualRenderingMode(
                    .offline, format: format, maximumFrameCount: maximumFrameCount)
            } catch {
                ExtAudioFileDispose(file)
                self.file = nil
                throw OggPlaybackError.engine(error.localizedDescription)
            }
        }
        engine.prepare()
    }

    deinit {
        playerNode.stop()
        engine.stop()
        if let file { ExtAudioFileDispose(file) }
    }

    /// The file's rate, its length in those frames, and the seconds that fall
    /// out of the division.
    ///
    /// The division is by the **file** format's rate, not the client's. An Opus
    /// stream's granule positions are 48 kHz whatever the audio inside is, so
    /// dividing a 48 kHz length by the 16 kHz client rate reports a 105-second
    /// recording as 315 seconds — a scrubber three times too long with two
    /// thirds of it unreachable.
    private static func readGeometry(file: ExtAudioFileRef, url: URL)
        -> (seconds: TimeInterval, rate: Double, frames: Int64)
    {
        var fileFormat = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let gotFormat = ExtAudioFileGetProperty(
            file, kExtAudioFileProperty_FileDataFormat, &formatSize, &fileFormat)

        var frames: Int64 = 0
        var framesSize = UInt32(MemoryLayout<Int64>.size)
        let gotFrames = ExtAudioFileGetProperty(
            file, kExtAudioFileProperty_FileLengthFrames, &framesSize, &frames)

        let rate = gotFormat == noErr ? fileFormat.mSampleRate : 0
        if gotFrames == noErr, frames > 0, rate > 0 {
            return (Double(frames) / rate, rate, frames)
        }
        // Older OS versions report 0 frames for an Ogg stream. `AVAudioPlayer`
        // still opens it and still reports a duration — it is only *seeking*
        // that it cannot do — so it stays as the fallback, and the frame count
        // is derived back from it so seeking still has an end to clamp to.
        let seconds = (try? AVAudioPlayer(contentsOf: url))?.duration ?? 0
        guard seconds > 0, rate > 0 else { return (seconds, rate, 0) }
        return (seconds, rate, Int64(seconds * rate))
    }

    // MARK: transport

    public var isPlaying: Bool {
        playerNode.isPlaying
    }

    /// Seek base plus what the node has actually rendered since. Clamped to the
    /// duration: the last buffer can render a few frames of padding past the
    /// end and a clock that reads 105.02 / 105.00 looks broken.
    public var currentTime: TimeInterval {
        refreshFrames()
        return stateLock.withLock {
            guard _positionValid else { return min(max(0, _seekBase), duration) }
            let seconds = _seekBase + Double(_framesSinceSeek) / Self.sampleRate
            return min(max(0, seconds), duration)
        }
    }

    public var rate: Double {
        get { Double(timePitch.rate) }
        set { timePitch.rate = Float(min(max(0.25, newValue), 4)) }
    }

    /// Start, or resume after a pause. Throws only if the engine will not run —
    /// which on a phone means the audio session was not activated first.
    public func play() throws {
        try queue.sync {
            guard file != nil else { throw OggPlaybackError.empty }
            finished = false
            wantsPlaying = true
            try startEngineIfNeeded()
            pump()
            playerNode.play()
        }
    }

    public func pause() {
        queue.sync {
            wantsPlaying = false
            refreshFrames()
            playerNode.pause()
            engine.pause()
        }
    }

    /// Move the playhead. Safe to call on every frame of a drag: the actual
    /// reposition happens on the queue and **the latest target wins** — a seek
    /// that arrives while a previous one is still re-priming replaces it rather
    /// than queueing behind it.
    ///
    /// The reported clock moves immediately, before the audio does, because the
    /// thing dragging it is a finger and it has to follow.
    public func seek(to time: TimeInterval) {
        let clamped = min(max(0, time), duration)
        stateLock.withLock {
            _pendingSeek = clamped
            _seekBase = clamped
            _framesSinceSeek = 0
            _positionValid = false
        }
        queue.async { [weak self] in
            guard let self else { return }
            let target = self.stateLock.withLock { () -> TimeInterval? in
                defer { self._pendingSeek = nil }
                return self._pendingSeek
            }
            // Nil means a later call to this block already applied a newer
            // target. Dropping the stale work is the whole coalescing trick.
            guard let target else { return }
            self.apply(seek: target)
        }
    }

    /// The graph lost its output device or its format underneath us. Rebuild
    /// the connections and pick up where the clock says we were.
    public func handleConfigurationChange() {
        queue.sync {
            let resume = wantsPlaying
            let position = currentTime
            engine.stop()
            engine.connect(playerNode, to: timePitch, format: format)
            engine.connect(timePitch, to: engine.mainMixerNode, format: format)
            engine.prepare()
            wantsPlaying = resume
            apply(seek: position)
        }
    }

    /// Stop everything and let go of the file. The object is done after this.
    public func close() {
        queue.sync {
            wantsPlaying = false
            generation += 1
            playerNode.stop()
            engine.stop()
            lookahead = nil
            if let file {
                ExtAudioFileDispose(file)
                self.file = nil
            }
        }
    }

    // MARK: the decoder

    private func startEngineIfNeeded() throws {
        guard !engine.isRunning else { return }
        do {
            try engine.start()
        } catch {
            throw OggPlaybackError.engine(error.localizedDescription)
        }
    }

    /// Reposition the decoder and the node together.
    ///
    /// `playerNode.stop()` is what makes the arithmetic in `currentTime` work:
    /// it throws away the buffers that were queued for the old position *and*
    /// resets the node's `sampleTime` to zero, so from here `sampleTime` counts
    /// frames since this seek and nothing else.
    private func apply(seek target: TimeInterval) {
        guard let file else { return }
        generation += 1
        let resume = wantsPlaying

        playerNode.stop()
        // Time pitch holds a window of the audio it was given; without this the
        // first tenth of a second after a seek is still the *old* position,
        // smeared over the new one.
        timePitch.reset()

        // In **file** frames — 48 kHz Opus granules — not the 16 kHz client
        // frames the rest of this file counts in. AudioToolbox documents the
        // offset as being in the file's format, and it means it: asking for
        // `time × 16000` seeks to a third of the intended position, which looks
        // exactly like a seek that works until you listen to it.
        //
        // Clamped one frame short of the end because a seek *to* the end fails
        // (`ExtAudioFileSeek` returns an error) and leaves the reader back at
        // frame 0 — a scrubber dragged to the right-hand edge would restart the
        // recording.
        var frame = Int64((target * fileSampleRate).rounded())
        if fileLengthFrames > 0 { frame = min(frame, fileLengthFrames - 1) }
        ExtAudioFileSeek(file, max(0, frame))

        lookahead = nil
        primed = false
        readerAtEnd = false
        finalScheduled = false
        scheduledFrames = 0
        finished = false
        stateLock.withLock {
            _seekBase = target
            _framesSinceSeek = 0
            _positionValid = true
        }

        pump()
        if resume {
            try? startEngineIfNeeded()
            playerNode.play()
        }
    }

    /// Keep `buffersAhead` buffers' worth of audio queued on the node.
    ///
    /// Called from the queue only. How far ahead we are is measured against the
    /// node's own `sampleTime` rather than a count of outstanding completions,
    /// so an offline render that never delivers a completion on time still gets
    /// fed.
    private func pump() {
        guard file != nil, !finalScheduled else { return }
        refreshFrames()
        let played = stateLock.withLock { _framesSinceSeek }
        let target = AVAudioFramePosition(Self.bufferFrames) * Self.buffersAhead

        while scheduledFrames - played < target {
            if !primed {
                lookahead = readNext()
                primed = true
                if lookahead == nil { readerAtEnd = true }
            }
            guard let current = lookahead else {
                // End of file with nothing queued: either the file was empty or
                // a seek landed past the last frame. Either way there is no
                // buffer left to carry the finish, so report it here.
                if scheduledFrames == 0, wantsPlaying { reportFinished() }
                return
            }
            let next = readerAtEnd ? nil : readNext()
            if next == nil { readerAtEnd = true }
            lookahead = next
            let isFinal = next == nil
            let stamp = generation

            playerNode.scheduleBuffer(
                current,
                completionCallbackType: isFinal ? finalCallbackType : .dataConsumed
            ) { [weak self] _ in
                // Never touch queue-owned state from the render thread.
                guard let self else { return }
                self.queue.async { [weak self] in
                    self?.completed(generation: stamp, final: isFinal)
                }
            }
            scheduledFrames += AVAudioFramePosition(current.frameLength)
            if isFinal {
                finalScheduled = true
                return
            }
        }
    }

    /// How the *last* buffer reports in.
    ///
    /// `.dataPlayedBack` is the honest one: it means the audio has left the
    /// speaker, which is the moment `audioPlayerDidFinishPlaying` used to fire,
    /// and it is what real playback uses. A manual-rendering engine has no
    /// speaker and never posts it — measured: neither `.dataPlayedBack` nor
    /// `.dataRendered` is ever delivered offline, only `.dataConsumed` — so the
    /// offline path settles for "the node has taken the last buffer", which is
    /// the same instant to within the graph's own latency.
    private var finalCallbackType: AVAudioPlayerNodeCompletionCallbackType {
        isOffline ? .dataConsumed : .dataPlayedBack
    }

    /// `.dataConsumed` for a middle buffer — the node has taken it, read the
    /// next one. The last one is the end; see `finalCallbackType`.
    private func completed(generation stamp: Int, final: Bool) {
        // From before a seek or a close: that audio is nobody's business now.
        guard stamp == generation else { return }
        if final {
            reportFinished()
        } else {
            pump()
        }
    }

    private func reportFinished() {
        guard !finished else { return }
        finished = true
        wantsPlaying = false
        playerNode.stop()
        stateLock.withLock {
            _seekBase = duration
            _framesSinceSeek = 0
            _positionValid = true
        }
        let callback = stateLock.withLock { _onFinish }
        callback?()
    }

    /// One buffer of decoded audio, or nil at the end of the file.
    ///
    /// `ExtAudioFileRead` signals the end with `count == 0` rather than an
    /// error, and is allowed to hand back fewer frames than asked for at any
    /// time — a short buffer is scheduled as-is, only an empty one ends the
    /// stream.
    private func readNext() -> AVAudioPCMBuffer? {
        guard let file,
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: Self.bufferFrames),
            let channel = buffer.floatChannelData?[0]
        else { return nil }

        var count = Self.bufferFrames
        var list = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: Self.bufferFrames * 4,
                mData: UnsafeMutableRawPointer(channel)))
        let status = ExtAudioFileRead(file, &count, &list)
        guard status == noErr, count > 0 else { return nil }
        buffer.frameLength = count
        return buffer
    }

    /// Pull the node's render position into `_framesSinceSeek`.
    ///
    /// Only while it is playing: a paused node has no meaningful render time,
    /// and freezing the last reading is exactly what a paused clock should do.
    /// Monotonic within a seek generation so a reading taken across a
    /// `stop()`/`play()` cannot make the clock stutter backwards.
    private func refreshFrames() {
        guard playerNode.isPlaying, let nodeTime = playerNode.lastRenderTime else { return }
        // `playerTime(forNodeTime:)` raises rather than returning nil if handed
        // a time with neither clock valid, which is what a manual-rendering
        // engine hands back before its first render.
        guard nodeTime.isSampleTimeValid || nodeTime.isHostTimeValid,
            let playerTime = playerNode.playerTime(forNodeTime: nodeTime)
        else { return }
        stateLock.withLock {
            guard _positionValid else { return }
            _framesSinceSeek = max(_framesSinceSeek, playerTime.sampleTime)
        }
    }
}

// MARK: - offline rendering

extension OggPlaybackEngine {

    /// Render `seconds` of audio into a buffer instead of out of a speaker.
    ///
    /// The whole point of the tests: what a scrubber is *supposed* to do is
    /// change the samples, and the only way to assert on samples is to render
    /// them. Requires `Output.offline`.
    public func renderOffline(seconds: Double) throws -> AVAudioPCMBuffer {
        guard isOffline else { throw OggPlaybackError.wrongMode }
        let renderFormat = engine.manualRenderingFormat
        let total = AVAudioFrameCount((seconds * renderFormat.sampleRate).rounded())
        guard total > 0,
            let out = AVAudioPCMBuffer(pcmFormat: renderFormat, frameCapacity: total),
            let slice = AVAudioPCMBuffer(
                pcmFormat: renderFormat,
                frameCapacity: engine.manualRenderingMaximumFrameCount),
            let destination = out.floatChannelData?[0],
            let source = slice.floatChannelData?[0]
        else { throw OggPlaybackError.engine("cannot allocate a render buffer") }

        var done: AVAudioFrameCount = 0
        while done < total {
            // Top up synchronously rather than waiting on a completion: offline
            // rendering can outrun the callbacks, and a test that sometimes
            // renders silence is worse than no test.
            queue.sync { pump() }
            let want = min(engine.manualRenderingMaximumFrameCount, total - done)
            let status = try engine.renderOffline(want, to: slice)
            switch status {
            case .success, .insufficientDataFromInputNode:
                let produced = min(slice.frameLength, want)
                if produced > 0 {
                    destination.advanced(by: Int(done))
                        .update(from: source, count: Int(produced))
                }
                // Anything short is the end of the stream; leave it as the
                // silence the buffer was allocated with.
                if produced < want {
                    destination.advanced(by: Int(done + produced))
                        .update(repeating: 0, count: Int(want - produced))
                }
            case .cannotDoInCurrentContext:
                throw OggPlaybackError.engine("renderOffline: cannot do in current context")
            case .error:
                throw OggPlaybackError.engine("renderOffline failed")
            @unknown default:
                throw OggPlaybackError.engine("renderOffline: unknown status")
            }
            done += want
        }
        out.frameLength = total
        return out
    }
}
