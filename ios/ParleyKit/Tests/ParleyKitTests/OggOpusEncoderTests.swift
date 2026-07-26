import XCTest

@testable import ParleyKit

/// Structural validation of the Ogg/Opus output — pages parse, checksums
/// verify, headers carry the desktop-contract fields (16 kHz mono).
final class OggOpusEncoderTests: XCTestCase {
    private func encodeSine(seconds: Double) throws -> Data {
        var out = Data()
        let enc = try OggOpusEncoder { out.append($0) }
        let total = Int(Double(OggOpusEncoder.sampleRate) * seconds)
        var samples: [Int16] = []
        samples.reserveCapacity(total)
        for i in 0..<total {
            let t = Double(i) / Double(OggOpusEncoder.sampleRate)
            samples.append(Int16(8000 * sin(2 * .pi * 440 * t)))
        }
        // Feed in uneven chunks like a real capture callback would.
        var rest = samples[...]
        for size in [1234, 4096, 777] where !rest.isEmpty {
            enc.append(Array(rest.prefix(size)))
            rest = rest.dropFirst(min(size, rest.count))
        }
        enc.append(Array(rest))
        enc.finalize()
        return out
    }

    func testProducesValidOggOpusStructure() throws {
        let data = try encodeSine(seconds: 1.0)

        XCTAssertGreaterThan(data.count, 500, "1s of 24kbps opus should be ~3KB+")
        XCTAssertEqual(String(data: data.prefix(4), encoding: .ascii), "OggS")

        // Walk every page: verify capture pattern + CRC.
        var offset = 0
        var pageCount = 0
        var sawBOS = false, sawEOS = false
        var payload = Data()
        while offset + 27 <= data.count {
            XCTAssertEqual(
                String(data: data.subdata(in: offset..<offset + 4), encoding: .ascii), "OggS",
                "page \(pageCount) magic at \(offset)")
            let flags = data[offset + 5]
            if flags & 0x02 != 0 { sawBOS = true }
            if flags & 0x04 != 0 { sawEOS = true }
            let segCount = Int(data[offset + 26])
            let lacing = data.subdata(in: (offset + 27)..<(offset + 27 + segCount))
            let bodyLen = lacing.reduce(0) { $0 + Int($1) }
            let pageEnd = offset + 27 + segCount + bodyLen
            XCTAssertLessThanOrEqual(pageEnd, data.count)

            // CRC check: zero the CRC field and recompute.
            var page = data.subdata(in: offset..<pageEnd)
            let stored = page.subdata(in: 22..<26).withUnsafeBytes {
                $0.load(as: UInt32.self).littleEndian
            }
            page.replaceSubrange(22..<26, with: Data([0, 0, 0, 0]))
            XCTAssertEqual(OggOpusEncoder.oggCRC(page), stored, "page \(pageCount) CRC")

            payload.append(data.subdata(in: (offset + 27 + segCount)..<pageEnd))
            offset = pageEnd
            pageCount += 1
        }
        XCTAssertEqual(offset, data.count, "no trailing garbage")
        XCTAssertTrue(sawBOS, "has beginning-of-stream page")
        XCTAssertTrue(sawEOS, "has end-of-stream page")
        XCTAssertGreaterThanOrEqual(pageCount, 3, "OpusHead + OpusTags + audio")

        // Header contents per the desktop contract.
        XCTAssertEqual(String(data: payload.prefix(8), encoding: .ascii), "OpusHead")
        XCTAssertEqual(payload[8], 1, "version")
        XCTAssertEqual(payload[9], 1, "mono")
        let inputRate = payload.subdata(in: 12..<16).withUnsafeBytes {
            $0.load(as: UInt32.self).littleEndian
        }
        XCTAssertEqual(inputRate, 16_000)
        XCTAssertTrue(payload.range(of: Data("OpusTags".utf8)) != nil)
    }

    func testOggCRCKnownVector() {
        // CRC of "123456789" under the Ogg polynomial (CRC-32/POSIX family,
        // no reflection, init 0, xorout 0) is 0x89A1897F.
        XCTAssertEqual(OggOpusEncoder.oggCRC(Data("123456789".utf8)), 0x89A1_897F)
    }
}
