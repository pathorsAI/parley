import AVFoundation
import Foundation

public enum AudioFileDecoderError: Error, Equatable {
    /// AVFoundation could not open or read the file.
    case unreadable(String)
    /// The file opened but contained no audio.
    case empty
}

/// Turns an arbitrary audio file the user picked (m4a, mp3, wav, caf, …) into
/// Parley's one canonical recording format: 16 kHz mono Ogg/Opus, the same
/// bytes `AudioRecorder` produces live.
///
/// Only one format exists on purpose. The desktop's `PUT /recordings/:id/audio`
/// takes `audio/ogg`, the library plays back whatever is stored, and batch
/// transcription reads the very same object — so an import that converts once,
/// here, uploads once rather than shipping the original *and* a transcodable
/// copy over a phone's uplink.
public struct AudioFileDecoder: Sendable {
    /// Source frames pulled per converter turn. Bounded on purpose: an hour of
    /// 16 kHz PCM is ~115 MB and a phone that holds all of it gets jetsam-killed
    /// mid-import, so the file streams through in ~4 s slices instead.
    private static let chunkSeconds = 4.0

    /// Decode any AVAudioFile-readable audio file into 16 kHz mono Ogg/Opus at
    /// `destination`, and return the decoded duration in milliseconds.
    ///
    /// Streams in chunks — an hour-long import must never be held in memory at
    /// full PCM width (16 kHz × 2 B = ~115 MB/hr, which is how a phone gets
    /// jetsam-killed). `onProgress` reports 0.0…1.0 of the source consumed.
    public static func encodeToOggOpus(
        source: URL,
        destination: URL,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) throws -> UInt64 {
        // Everything that can fail without side effects happens before the
        // destination exists, so a rejected file never leaves a stray artifact.
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: source)
        } catch {
            throw AudioFileDecoderError.unreadable(error.localizedDescription)
        }
        let sourceFormat = file.processingFormat
        let sourceFrames = file.length
        guard sourceFrames > 0 else { throw AudioFileDecoderError.empty }

        // Int16 mono at 16 kHz is both what OggOpusEncoder eats and what makes
        // the converter do the resample *and* the multi-channel downmix for us.
        guard
            let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(OggOpusEncoder.sampleRate),
                channels: 1,
                interleaved: true),
            let converter = AVAudioConverter(from: sourceFormat, to: outputFormat)
        else {
            throw AudioFileDecoderError.unreadable(
                "cannot convert \(sourceFormat) to 16 kHz mono")
        }

        let fm = FileManager.default
        guard fm.createFile(atPath: destination.path, contents: nil),
            let handle = try? FileHandle(forWritingTo: destination)
        else {
            throw AudioFileDecoderError.unreadable(
                "cannot write to \(destination.lastPathComponent)")
        }

        var writeFailure: Error?
        let encoder: OggOpusEncoder
        do {
            encoder = try OggOpusEncoder { page in
                guard writeFailure == nil else { return }
                do { try handle.write(contentsOf: page) } catch { writeFailure = error }
            }
        } catch {
            try? handle.close()
            try? fm.removeItem(at: destination)
            throw AudioFileDecoderError.unreadable(error.localizedDescription)
        }

        /// Close the stream out and take the half-written file with it — a
        /// partial Ogg at `destination` would look like a real recording to
        /// every later stage.
        func abort(_ reason: AudioFileDecoderError) -> AudioFileDecoderError {
            encoder.finalize()
            try? handle.close()
            try? fm.removeItem(at: destination)
            return reason
        }

        guard
            let inputBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat,
                frameCapacity: AVAudioFrameCount(sourceFormat.sampleRate * chunkSeconds)),
            let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: outputFormat,
                frameCapacity: AVAudioFrameCount(outputFormat.sampleRate * chunkSeconds))
        else {
            throw abort(.unreadable("cannot allocate conversion buffers"))
        }

        var readFailure: Error?
        var framesRead: AVAudioFramePosition = 0
        var exhausted = false
        let feed: AVAudioConverterInputBlock = { _, status in
            // Never ask for frames past the end: AVAudioFile.read throws at EOF
            // rather than politely returning zero frames, and that would look
            // like a corrupt file instead of a finished one.
            let remaining = sourceFrames - file.framePosition
            if exhausted || remaining <= 0 {
                exhausted = true
                status.pointee = .endOfStream
                return nil
            }
            do {
                try file.read(
                    into: inputBuffer,
                    frameCount: AVAudioFrameCount(
                        min(remaining, AVAudioFramePosition(inputBuffer.frameCapacity))))
            } catch {
                readFailure = error
                status.pointee = .endOfStream
                return nil
            }
            guard inputBuffer.frameLength > 0 else {
                // Signal end-of-stream rather than "no data now", or the
                // converter keeps the tail of the file in its resampler.
                exhausted = true
                status.pointee = .endOfStream
                return nil
            }
            framesRead += AVAudioFramePosition(inputBuffer.frameLength)
            status.pointee = .haveData
            return inputBuffer
        }

        var decodedFrames: UInt64 = 0
        var draining = true
        while draining {
            outputBuffer.frameLength = 0
            var convertError: NSError?
            let status = converter.convert(
                to: outputBuffer, error: &convertError, withInputFrom: feed)

            if let readFailure {
                throw abort(.unreadable(readFailure.localizedDescription))
            }
            if status == .error {
                throw abort(
                    .unreadable(convertError?.localizedDescription ?? "conversion failed"))
            }
            if let writeFailure {
                throw abort(.unreadable(writeFailure.localizedDescription))
            }

            let produced = Int(outputBuffer.frameLength)
            if produced > 0, let pcm = outputBuffer.int16ChannelData?[0] {
                encoder.append(Array(UnsafeBufferPointer(start: pcm, count: produced)))
                decodedFrames += UInt64(produced)
            }
            // `.inputRanDry` cannot happen (the block never returns .noDataNow),
            // but treat it as a stop anyway so a surprise can't spin forever.
            if status != .haveData || (produced == 0 && exhausted) { draining = false }

            onProgress?(min(1.0, Double(framesRead) / Double(sourceFrames)))
        }

        guard decodedFrames > 0 else { throw abort(.empty) }

        encoder.finalize()
        if let writeFailure {
            try? handle.close()
            try? fm.removeItem(at: destination)
            throw AudioFileDecoderError.unreadable(writeFailure.localizedDescription)
        }
        try? handle.close()
        onProgress?(1.0)

        // Reported from what was actually encoded, not from the source's
        // declared length: a truncated file should own up to how much of it
        // really decoded.
        return UInt64((Double(decodedFrames) * 1000 / Double(OggOpusEncoder.sampleRate)).rounded())
    }
}
