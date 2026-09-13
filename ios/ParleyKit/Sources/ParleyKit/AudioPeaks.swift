import AudioToolbox
import Foundation

public enum AudioPeaksError: Error, Equatable {
    /// AudioToolbox could not open the file, or could not be persuaded to hand
    /// back 16 kHz mono float.
    case unreadable(String)
    /// The file opened but decoded to nothing.
    case empty
    /// A cache file that is not one of ours, or is truncated.
    case corruptCache
    /// `isCancelled` said so. Not `Swift.CancellationError`, because `compute`
    /// is a blocking synchronous function with no Task to cancel — the caller
    /// owns that decision and passes it in.
    case cancelled
}

/// The whole of a recording reduced to a few hundred numbers — the overview
/// waveform behind the player's scrubber.
///
/// ## Why this is not `WaveformView`'s data
///
/// The live waveform is a *history*: `AudioCapture` hands it one RMS value per
/// chunk as the meeting runs, and it draws the last few seconds. A finished
/// recording needs the opposite shape — the entire file at once, so a person can
/// see where the quiet stretch was and drag to it. That cannot come from the
/// capture tap, because the capture happened on another device half the time.
/// So it is computed from the decoded audio, once, and kept.
///
/// ## Reading the Ogg
///
/// `ExtAudioFile` with a 16 kHz mono float client format does the demux, the
/// Opus decode and the rate conversion in one step, which is why there is no
/// hand-written Ogg parser in this file. Two things about Ogg to know before
/// changing it:
///
/// - `kExtAudioFileProperty_FileLengthFrames` reads **0** for an Ogg stream.
///   There is no frame count in the container's header — it is implied by the
///   last page's granule position, and AudioToolbox does not go looking. So the
///   length is discovered by reading to the end, and `onProgress` needs a
///   duration handed to it from outside (the player knows it) rather than
///   computing one.
/// - `ExtAudioFileRead` returns `count == 0` at the end rather than an error.
///
/// ## Two resolutions, on purpose
///
/// The streaming pass measures RMS over a 20 ms window — the same 20 ms the
/// encoder frames at — into a coarse array, and only then reduces that to
/// `bucketCount`. One pass cannot bucket straight into 400 slots without
/// knowing the total length first, and the coarse array is cheap: an hour of
/// audio is 180,000 floats, 720 KB, alive for the length of one computation.
public struct AudioPeaks: Sendable {
    /// What gets cached. A 430pt-wide phone draws ~130 bars at 3pt each, so 400
    /// leaves room for a wider screen and for a future zoom without a recompute,
    /// and costs 1.6 KB on disk.
    public static let bucketCount = 400
    /// The coarse pass's window, in samples at 16 kHz — 20 ms.
    private static let windowSamples = 320
    /// Frames pulled per `ExtAudioFileRead`. One second at 16 kHz: small enough
    /// that a cancelled computation stops promptly, large enough that an hour of
    /// audio is 3,600 calls rather than 180,000.
    private static let readSamples = 16_000

    /// Values are **raw RMS in 0…1, not normalised**. Normalising here would
    /// bake a decision the drawing has to make anyway (a whispered meeting has
    /// to fill the field or it reads as an empty file), and it would make the
    /// cache a function of the loudest moment — so re-deriving it later, for a
    /// zoom or a different height, would need the audio back.
    public struct Overview: Sendable, Equatable {
        public let peaks: [Float]
        /// How long the audio actually decoded to. Kept so a cache written for a
        /// different file under a reused recording id can be spotted and thrown
        /// away rather than drawn over the wrong duration.
        public let seconds: TimeInterval

        public init(peaks: [Float], seconds: TimeInterval) {
            self.peaks = peaks
            self.seconds = seconds
        }
    }

    /// Decode `url` and reduce it to `buckets` RMS values.
    ///
    /// Blocking and CPU-bound — call it off the main actor. `expectedSeconds`
    /// only feeds `onProgress`; pass what the player reports as the duration, or
    /// nil to get a single 1.0 at the end. `isCancelled` is polled once per read
    /// turn so a screen that goes away does not keep a core busy.
    public static func compute(
        url: URL,
        expectedSeconds: TimeInterval? = nil,
        buckets: Int = bucketCount,
        isCancelled: (@Sendable () -> Bool)? = nil,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) throws -> Overview {
        guard buckets > 0 else { throw AudioPeaksError.unreadable("buckets must be positive") }

        var ref: ExtAudioFileRef?
        let opened = ExtAudioFileOpenURL(url as CFURL, &ref)
        guard opened == noErr, let file = ref else {
            throw AudioPeaksError.unreadable("ExtAudioFileOpenURL failed (\(opened))")
        }
        defer { ExtAudioFileDispose(file) }

        // Mono float at the recording rate: the converter does the Opus decode,
        // the 48 kHz → 16 kHz resample and the downmix, so everything below is
        // plain arithmetic over one channel.
        var client = AudioStreamBasicDescription(
            mSampleRate: Float64(OggOpusEncoder.sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        let configured = ExtAudioFileSetProperty(
            file, kExtAudioFileProperty_ClientDataFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client)
        guard configured == noErr else {
            throw AudioPeaksError.unreadable("client format rejected (\(configured))")
        }

        var scratch = [Float](repeating: 0, count: readSamples)
        /// RMS per 20 ms, in order. Reduced to `buckets` once the length is known.
        var coarse: [Float] = []
        coarse.reserveCapacity(3_000)
        /// Carried across reads: a read boundary is not a window boundary.
        var windowSum = 0.0
        var windowCount = 0
        var totalFrames = 0
        var lastReported = -1.0

        while true {
            if isCancelled?() == true { throw AudioPeaksError.cancelled }
            var count = UInt32(readSamples)
            let status = scratch.withUnsafeMutableBytes { raw -> OSStatus in
                var list = AudioBufferList(
                    mNumberBuffers: 1,
                    mBuffers: AudioBuffer(
                        mNumberChannels: 1, mDataByteSize: UInt32(raw.count),
                        mData: raw.baseAddress))
                return ExtAudioFileRead(file, &count, &list)
            }
            guard status == noErr else {
                throw AudioPeaksError.unreadable("ExtAudioFileRead failed (\(status))")
            }
            if count == 0 { break }

            for index in 0..<Int(count) {
                let sample = Double(scratch[index])
                windowSum += sample * sample
                windowCount += 1
                if windowCount == windowSamples {
                    coarse.append(Float((windowSum / Double(windowCount)).squareRoot()))
                    windowSum = 0
                    windowCount = 0
                }
            }
            totalFrames += Int(count)

            if let expectedSeconds, expectedSeconds > 0, let onProgress {
                let fraction = min(
                    1, Double(totalFrames) / (expectedSeconds * Double(OggOpusEncoder.sampleRate)))
                // Whole percent only: a callback that hops onto the main actor
                // 3,600 times for an hour-long file is a stutter, not progress.
                if fraction - lastReported >= 0.01 {
                    lastReported = fraction
                    onProgress(fraction)
                }
            }
        }

        // The tail window, so the last fifth of a second is not silently dropped.
        if windowCount > 0 {
            coarse.append(Float((windowSum / Double(windowCount)).squareRoot()))
        }
        guard totalFrames > 0, !coarse.isEmpty else { throw AudioPeaksError.empty }

        onProgress?(1.0)
        return Overview(
            peaks: resample(coarse, to: buckets),
            seconds: Double(totalFrames) / Double(OggOpusEncoder.sampleRate))
    }

    /// Reduce or stretch a peak array to exactly `count` values.
    ///
    /// Combined as RMS rather than by taking the maximum: the maximum of a
    /// hundred windows is whichever one clipped, so a downsampled waveform drawn
    /// that way is a flat bar at full height for any recording with a cough in
    /// it. Averaging energy keeps the shape of the conversation.
    ///
    /// Stretching (fewer values than asked for, which is every recording under
    /// eight seconds) repeats the nearest value rather than interpolating: a
    /// three-second clip should read as the handful of marks it is.
    public static func resample(_ values: [Float], to count: Int) -> [Float] {
        guard count > 0 else { return [] }
        guard !values.isEmpty else { return Array(repeating: 0, count: count) }
        if values.count == count { return values }
        if values.count < count {
            return (0..<count).map { index in
                values[min(values.count - 1, index * values.count / count)]
            }
        }
        return (0..<count).map { index in
            let start = index * values.count / count
            let end = max(start + 1, (index + 1) * values.count / count)
            var sum = 0.0
            for position in start..<min(end, values.count) {
                let value = Double(values[position])
                sum += value * value
            }
            return Float((sum / Double(min(end, values.count) - start)).squareRoot())
        }
    }

    // MARK: the cache file

    /// `PKW1`, big-endian so a hex dump reads as the letters.
    static let magic: UInt32 = 0x504B_5731

    /// The on-disk form: 16 bytes of header, then one `Float32` per bucket.
    ///
    /// A binary rather than the JSON the design sketch allowed for, because the
    /// numbers are the entire content: 400 floats are 1,600 bytes here and about
    /// 4,800 as JSON text, and nothing ever needs to read this file by eye.
    public static func encode(_ overview: Overview) -> Data {
        var data = Data(capacity: 16 + overview.peaks.count * 4)
        data.append(be32: magic)
        data.append(le32: UInt32(overview.peaks.count))
        data.append(le32: Float32(overview.seconds).bitPattern)
        data.append(le32: 0)  // reserved, keeps the payload 8-byte aligned
        for value in overview.peaks { data.append(le32: value.bitPattern) }
        return data
    }

    public static func decode(_ data: Data) throws -> Overview {
        guard data.count >= 16 else { throw AudioPeaksError.corruptCache }
        let bytes = [UInt8](data)
        func word(_ offset: Int) -> UInt32 {
            UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8
                | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
        }
        let stored = word(0).byteSwapped
        guard stored == magic else { throw AudioPeaksError.corruptCache }
        let count = Int(word(4))
        // An upper bound as well as a lower one: a corrupt length field must not
        // turn into a gigabyte allocation.
        guard count > 0, count <= 1 << 16, data.count >= 16 + count * 4 else {
            throw AudioPeaksError.corruptCache
        }
        let seconds = TimeInterval(Float32(bitPattern: word(8)))
        guard seconds.isFinite, seconds >= 0 else { throw AudioPeaksError.corruptCache }
        var peaks = [Float]()
        peaks.reserveCapacity(count)
        for index in 0..<count {
            let value = Float32(bitPattern: word(16 + index * 4))
            guard value.isFinite else { throw AudioPeaksError.corruptCache }
            peaks.append(value)
        }
        return Overview(peaks: peaks, seconds: seconds)
    }
}

extension Data {
    fileprivate mutating func append(be32 value: UInt32) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
    fileprivate mutating func append(le32 value: UInt32) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }
}
