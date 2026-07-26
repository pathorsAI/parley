import AVFoundation
import Foundation
import ParleyKit

/// Microphone capture → 16 kHz mono Int16 chunks, the pipeline's universal
/// format (desktop `TARGET_SAMPLE_RATE`; the relay meters 32 000 bytes/s).
///
/// The iOS counterpart of the desktop's `audio/microphone.rs`: capture at the
/// hardware format, then convert to 16 kHz mono s16le. Conversion uses
/// AVAudioConverter (proper resampling — the desktop's linear interpolator is
/// a fallback it only keeps because cpal has no converter).
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let onChunk: ([Int16], Float) -> Void

    /// `onChunk(samples, rmsLevel)` fires on an audio thread.
    init(onChunk: @escaping ([Int16], Float) -> Void) {
        self.onChunk = onChunk
    }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        // .playAndRecord + .voiceChat keeps echo cancellation available for the
        // future "phone as the room mic for a desktop session" mode; .default
        // would also work for pure capture.
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
        try session.setActive(true)

        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: Double(SonioxProtocol.sampleRate),
                channels: 1, interleaved: true),
            let converter = AVAudioConverter(from: hwFormat, to: target)
        else {
            throw NSError(
                domain: "AudioCapture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "cannot build 16k mono converter"])
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            self?.convert(buffer, with: converter, target: target)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private func convert(
        _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, target: AVAudioFormat
    ) {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var fed = false
        converter.convert(to: out, error: nil) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        var sum: Float = 0
        for s in samples {
            let f = Float(s) / 32768
            sum += f * f
        }
        let rms = (sum / Float(samples.count)).squareRoot()
        onChunk(samples, rms)
    }
}
