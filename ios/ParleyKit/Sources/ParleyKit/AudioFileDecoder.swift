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

    /// How long `source` runs, in seconds, read from the container without
    /// decoding a sample. `nil` when the file will not open or declares no
    /// length — the caller then behaves as if it did not know, which it does
    /// not.
    public static func durationSeconds(of source: URL) -> Double? {
        guard let file = try? AVAudioFile(forReading: source) else { return nil }
        let rate = file.fileFormat.sampleRate
        guard file.length > 0, rate > 0 else { return nil }
        return Double(file.length) / rate
    }

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
        let durations = try encodeToOggOpusParts(
            source: source, parts: 1, destination: { _ in destination }, onProgress: onProgress)
        return durations[0]
    }

    private static func decoderError(_ error: Error) -> AudioFileDecoderError {
        error as? AudioFileDecoderError ?? .unreadable(error.localizedDescription)
    }

    /// One part's Ogg stream while it is being written.
    private final class PartWriter {
        let url: URL
        let handle: FileHandle
        var encoder: OggOpusEncoder!
        var writeFailure: Error?
        var frames: UInt64 = 0

        init(url: URL) throws {
            guard FileManager.default.createFile(atPath: url.path, contents: nil),
                let handle = try? FileHandle(forWritingTo: url)
            else {
                throw AudioFileDecoderError.unreadable("cannot write to \(url.lastPathComponent)")
            }
            self.url = url
            self.handle = handle
            do {
                encoder = try OggOpusEncoder { [unowned self] page in
                    guard self.writeFailure == nil else { return }
                    do { try self.handle.write(contentsOf: page) } catch { self.writeFailure = error }
                }
            } catch {
                try? handle.close()
                try? FileManager.default.removeItem(at: url)
                throw AudioFileDecoderError.unreadable(error.localizedDescription)
            }
        }

        /// Flush the stream and close the file. Throws the first write failure.
        func finish() throws {
            encoder.finalize()
            try? handle.close()
            if let writeFailure {
                throw AudioFileDecoderError.unreadable(writeFailure.localizedDescription)
            }
        }
    }

    /// Decode `source` into `parts` consecutive 16 kHz mono Ogg/Opus files of
    /// equal length (`ImportSplit.partRanges` over the expected output), each
    /// a complete stream of its own at `destination(index)`, and return each
    /// part's decoded duration in milliseconds.
    ///
    /// The cut happens at sample offsets inside the same chunked pass a single
    /// file uses, so memory stays bounded however many parts there are. The
    /// last part takes whatever the source really yields past the final cut,
    /// so a container that misstates its length shortens or lengthens the
    /// last part rather than losing audio. A source shorter than its declared
    /// length can therefore come back with fewer parts than asked for.
    ///
    /// On any failure every part written so far is removed.
    public static func encodeToOggOpusParts(
        source: URL,
        parts requestedParts: Int,
        destination: (Int) -> URL,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) throws -> [UInt64] {
        let parts = max(1, requestedParts)
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

        // Where each part ends, in output samples. The last part is open-ended.
        let expectedSamples = Int64(
            (Double(sourceFrames) * outputFormat.sampleRate / sourceFormat.sampleRate).rounded())
        var cuts = ImportSplit.partEnds(totalSamples: expectedSamples, parts: parts)
        cuts[cuts.count - 1] = .max

        let fm = FileManager.default
        var finished: [PartWriter] = []
        var current: PartWriter?

        /// Close every stream out and take the files with them — a partial Ogg
        /// would look like a real recording to every later stage.
        func abort(_ reason: AudioFileDecoderError) -> AudioFileDecoderError {
            if let current {
                current.encoder.finalize()
                try? current.handle.close()
                try? fm.removeItem(at: current.url)
            }
            current = nil
            for part in finished { try? fm.removeItem(at: part.url) }
            return reason
        }

        // The first part is opened up front so an unwritable destination fails
        // before any decoding is spent on it.
        current = try PartWriter(url: destination(0))

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

        var decodedFrames: Int64 = 0
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

            let produced = Int(outputBuffer.frameLength)
            if produced > 0, let pcm = outputBuffer.int16ChannelData?[0] {
                var offset = 0
                while offset < produced {
                    if current == nil {
                        do {
                            current = try PartWriter(url: destination(finished.count))
                        } catch {
                            throw abort(Self.decoderError(error))
                        }
                    }
                    guard let writer = current else { break }
                    let cut = cuts[finished.count]
                    let take = Int(min(Int64(produced - offset), cut - decodedFrames))
                    writer.encoder.append(
                        Array(UnsafeBufferPointer(start: pcm + offset, count: take)))
                    if let failure = writer.writeFailure {
                        throw abort(.unreadable(failure.localizedDescription))
                    }
                    writer.frames += UInt64(take)
                    decodedFrames += Int64(take)
                    offset += take
                    if decodedFrames >= cut {
                        // This part is full: close its stream; the next one
                        // opens only when there is audio to put in it.
                        do { try writer.finish() } catch {
                            current = nil
                            finished.append(writer)
                            throw abort(Self.decoderError(error))
                        }
                        finished.append(writer)
                        current = nil
                    }
                }
            }
            // `.inputRanDry` cannot happen (the block never returns .noDataNow),
            // but treat it as a stop anyway so a surprise can't spin forever.
            if status != .haveData || (produced == 0 && exhausted) { draining = false }

            onProgress?(min(1.0, Double(framesRead) / Double(sourceFrames)))
        }

        guard decodedFrames > 0 else { throw abort(.empty) }

        if let writer = current {
            do { try writer.finish() } catch {
                current = nil
                finished.append(writer)
                throw abort(Self.decoderError(error))
            }
            finished.append(writer)
            current = nil
        }
        onProgress?(1.0)

        // Reported from what was actually encoded, not from the source's
        // declared length: a truncated file should own up to how much of it
        // really decoded.
        return finished.map {
            UInt64((Double($0.frames) * 1000 / Double(OggOpusEncoder.sampleRate)).rounded())
        }
    }
}
