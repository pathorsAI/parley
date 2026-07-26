import AudioToolbox
import Foundation

/// Incremental 16 kHz mono PCM → Ogg/Opus encoder, matching the desktop's
/// recording format (`src-tauri/src/replay_audio.rs`: Opus VOIP-ish, 24 kbps,
/// 20 ms frames, hand-built Ogg pages) so `PUT /recordings/:id/audio` with
/// `audio/ogg` holds the same kind of file no matter which device recorded.
///
/// Uses Apple's built-in Opus codec via AudioConverter — no C dependencies.
/// Feed samples as they arrive (`append`), then `finalize()` for the EOS page;
/// pages stream to `onPage` so a long meeting never lives in memory (design
/// doc D9).
public final class OggOpusEncoder {
    public static let sampleRate = 16_000
    public static let frameSamples = 320  // 20 ms @ 16 kHz
    public static let bitrate: UInt32 = 24_000
    /// One Opus frame in 48 kHz granule units (Ogg/Opus mandates 48 kHz).
    static let granulePerPacket: Int64 = 960

    private var converter: AudioConverterRef?
    private var preSkip48k: UInt16 = 312
    private var pending: [Int16] = []
    private var packets: [Data] = []
    private var packetCount: Int64 = 0
    private var pageSeq: UInt32 = 0
    private let serial = UInt32.random(in: 0..<UInt32.max)
    private var headerWritten = false
    private var finished = false
    private let onPage: (Data) -> Void

    public init(onPage: @escaping (Data) -> Void) throws {
        self.onPage = onPage

        var inDesc = AudioStreamBasicDescription(
            mSampleRate: Float64(Self.sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var outDesc = AudioStreamBasicDescription(
            mSampleRate: Float64(Self.sampleRate),
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: UInt32(Self.frameSamples),
            mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)

        var ref: AudioConverterRef?
        var status = AudioConverterNew(&inDesc, &outDesc, &ref)
        if status != noErr || ref == nil {
            // Some codec builds only expose Opus at its native 48 kHz packet
            // geometry; granule math below is rate-independent (20 ms = 960).
            outDesc.mSampleRate = 48_000
            outDesc.mFramesPerPacket = 960
            status = AudioConverterNew(&inDesc, &outDesc, &ref)
        }
        guard status == noErr, let converter = ref else {
            throw NSError(
                domain: "OggOpusEncoder", code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "AudioConverterNew failed (\(status))"])
        }
        self.converter = converter

        var rate = Self.bitrate
        AudioConverterSetProperty(
            converter, kAudioConverterEncodeBitRate,
            UInt32(MemoryLayout<UInt32>.size), &rate)

        var prime = AudioConverterPrimeInfo(leadingFrames: 0, trailingFrames: 0)
        var primeSize = UInt32(MemoryLayout<AudioConverterPrimeInfo>.size)
        if AudioConverterGetProperty(
            converter, kAudioConverterPrimeInfo, &primeSize, &prime) == noErr
        {
            // Convert the encoder's priming (input-rate frames) to 48 kHz.
            let factor = 48_000 / Self.sampleRate
            preSkip48k = UInt16(clamping: Int(prime.leadingFrames) * factor)
        }
    }

    public func append(_ samples: [Int16]) {
        guard !finished else { return }
        pending.append(contentsOf: samples)
        drain(flushPartial: false)
        emitPages(force: false, eos: false)
    }

    public func finalize() {
        guard !finished else { return }
        finished = true
        drain(flushPartial: true)
        emitPages(force: true, eos: true)
        if let converter { AudioConverterDispose(converter) }
        converter = nil
    }

    // MARK: Opus encoding

    private final class FeedState {
        var chunk: [Int16] = []
        var delivered = false
    }

    private func drain(flushPartial: Bool) {
        guard let converter else { return }
        if !headerWritten {
            writeHeaderPages()
            headerWritten = true
        }
        while pending.count >= Self.frameSamples || (flushPartial && !pending.isEmpty) {
            var chunk: [Int16]
            if pending.count >= Self.frameSamples {
                chunk = Array(pending.prefix(Self.frameSamples))
                pending.removeFirst(Self.frameSamples)
            } else {
                chunk = pending + [Int16](repeating: 0, count: Self.frameSamples - pending.count)
                pending.removeAll()
            }

            let state = FeedState()
            state.chunk = chunk

            var outBuffer = Data(count: 4096)
            var packetDesc = AudioStreamPacketDescription()
            var numPackets: UInt32 = 1
            let status = outBuffer.withUnsafeMutableBytes { raw -> OSStatus in
                var bufList = AudioBufferList(
                    mNumberBuffers: 1,
                    mBuffers: AudioBuffer(
                        mNumberChannels: 1, mDataByteSize: UInt32(raw.count),
                        mData: raw.baseAddress))
                return AudioConverterFillComplexBuffer(
                    converter, feedCallback,
                    Unmanaged.passUnretained(state).toOpaque(),
                    &numPackets, &bufList, &packetDesc)
            }
            // 501 (kAudioConverterErr_UnspecifiedError misuse) never expected;
            // "no more data" from our callback surfaces as numPackets == 0.
            if status != noErr && numPackets == 0 { break }
            if numPackets > 0 {
                let size = Int(packetDesc.mDataByteSize)
                let offset = Int(packetDesc.mStartOffset)
                packets.append(outBuffer.subdata(in: offset..<(offset + size)))
                packetCount += 1
            }
        }
    }

    private let feedCallback: AudioConverterComplexInputDataProc = {
        _, ioNumberDataPackets, ioData, _, inUserData in
        let state = Unmanaged<FeedState>.fromOpaque(inUserData!).takeUnretainedValue()
        if state.delivered {
            ioNumberDataPackets.pointee = 0
            return kAudioConverterErr_UnspecifiedError  // signals "no more input now"
        }
        state.delivered = true
        ioNumberDataPackets.pointee = UInt32(state.chunk.count)
        state.chunk.withUnsafeMutableBufferPointer { buf in
            ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(buf.baseAddress)
            ioData.pointee.mBuffers.mDataByteSize = UInt32(buf.count * 2)
            ioData.pointee.mBuffers.mNumberChannels = 1
        }
        return noErr
    }

    // MARK: Ogg container (port of replay_audio.rs's hand-built pages)

    private func writeHeaderPages() {
        var head = Data("OpusHead".utf8)
        head.append(1)  // version
        head.append(1)  // channel count
        head.append(le16: preSkip48k)
        head.append(le32: UInt32(Self.sampleRate))  // original input rate
        head.append(le16: 0)  // output gain
        head.append(0)  // mapping family
        onPage(oggPage(payloads: [head], granule: 0, flags: 0x02))  // BOS

        var tags = Data("OpusTags".utf8)
        let vendor = "Parley iOS"
        tags.append(le32: UInt32(vendor.utf8.count))
        tags.append(contentsOf: vendor.utf8)
        tags.append(le32: 0)  // no user comments
        onPage(oggPage(payloads: [tags], granule: 0, flags: 0x00))
    }

    /// Flush accumulated packets into pages of up to 50 packets (~1 s).
    private func emitPages(force: Bool, eos: Bool) {
        let pageSize = 50
        var emittedEOS = false
        while packets.count >= pageSize || (force && !packets.isEmpty) {
            let n = min(pageSize, packets.count)
            let slice = Array(packets.prefix(n))
            packets.removeFirst(n)
            let isLast = eos && packets.isEmpty
            emittedEOS = emittedEOS || isLast
            let granule = Int64(preSkip48k)
                + (packetCount - Int64(packets.count)) * Self.granulePerPacket
            onPage(oggPage(payloads: slice, granule: granule, flags: isLast ? 0x04 : 0x00))
        }
        if eos && !emittedEOS {
            // Everything already flushed at a page boundary (or empty stream):
            // close with a bare EOS page carrying the final granule.
            let granule = Int64(preSkip48k) + packetCount * Self.granulePerPacket
            onPage(oggPage(payloads: [], granule: granule, flags: 0x04))
        }
    }

    private func oggPage(payloads: [Data], granule: Int64, flags: UInt8) -> Data {
        var lacing = Data()
        for p in payloads {
            var remaining = p.count
            while remaining >= 255 {
                lacing.append(255)
                remaining -= 255
            }
            lacing.append(UInt8(remaining))
        }
        var page = Data("OggS".utf8)
        page.append(0)  // stream structure version
        page.append(flags)
        page.append(le64: UInt64(bitPattern: granule))
        page.append(le32: serial)
        page.append(le32: pageSeq)
        pageSeq += 1
        page.append(le32: 0)  // CRC placeholder
        page.append(UInt8(lacing.count))
        page.append(lacing)
        for p in payloads { page.append(p) }

        let crc = Self.oggCRC(page)
        page.replaceSubrange(22..<26, with: withUnsafeBytes(of: crc.littleEndian) { Data($0) })
        return page
    }

    /// Ogg CRC-32: poly 0x04C11DB7, init 0, no reflection, no final xor.
    static func oggCRC(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0
        for byte in data {
            crc ^= UInt32(byte) << 24
            for _ in 0..<8 {
                crc = (crc & 0x8000_0000) != 0 ? (crc << 1) ^ 0x04C1_1DB7 : crc << 1
            }
        }
        return crc
    }
}

extension Data {
    fileprivate mutating func append(le16 v: UInt16) {
        Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) }
    }
    fileprivate mutating func append(le32 v: UInt32) {
        Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) }
    }
    fileprivate mutating func append(le64 v: UInt64) {
        Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) }
    }
}
