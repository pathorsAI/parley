import Foundation

/// How an imported file longer than one hosted transcription is cut into
/// parts. Pure arithmetic, shared by the probe (how many parts to offer), the
/// decoder (where to cut) and the importer (what to call each part).
///
/// The server caps one hosted transcription at 6 h (`STT_MAX_SESSION_SECONDS`)
/// and a request body at 100 MB (≈9 h of the 24 kbps Opus the phone encodes).
/// A part is held to 5 h 50 m so container overhead and the decoder's rounding
/// never push one over the 6 h line.
public enum ImportSplit {
    /// The longest a single part may run, in seconds.
    public static let hostedMaxPartSeconds: Double = 5 * 3600 + 50 * 60

    /// How many equal parts a file of `durationSeconds` needs. `nil` — the
    /// container did not say how long it is — means 1: the import behaves as
    /// it did before splitting existed, and the server is the judge.
    public static func partCount(durationSeconds: Double?) -> Int {
        guard let duration = durationSeconds, duration.isFinite, duration > hostedMaxPartSeconds
        else { return 1 }
        return Int((duration / hostedMaxPartSeconds).rounded(.up))
    }

    /// Where each part ends, as exclusive sample offsets into a stream of
    /// `totalSamples`. Parts are equal to the sample, except that the first
    /// `totalSamples % parts` parts carry one extra sample. The last end is
    /// always `totalSamples`.
    public static func partEnds(totalSamples: Int64, parts: Int) -> [Int64] {
        guard parts > 1, totalSamples > 0 else { return [max(0, totalSamples)] }
        let base = totalSamples / Int64(parts)
        let extra = totalSamples % Int64(parts)
        var ends: [Int64] = []
        var cursor: Int64 = 0
        for index in 0..<parts {
            cursor += base + (Int64(index) < extra ? 1 : 0)
            ends.append(cursor)
        }
        return ends
    }

    /// The sample ranges of each part — `partEnds` as half-open ranges.
    public static func partRanges(totalSamples: Int64, parts: Int) -> [Range<Int64>] {
        var start: Int64 = 0
        return partEnds(totalSamples: totalSamples, parts: parts).map { end in
            defer { start = end }
            return start..<end
        }
    }

    /// `name` with the part suffix the library shows: `會議（1/3）` in
    /// Chinese, with full-width brackets and no space, and `Meeting (1/3)`
    /// otherwise. A single part keeps the name as it is.
    public static func partTitle(_ name: String, part: Int, of parts: Int, chinese: Bool) -> String {
        guard parts > 1 else { return name }
        return chinese ? "\(name)（\(part)/\(parts)）" : "\(name) (\(part)/\(parts))"
    }

    /// `seconds` as whole hours and minutes, rounded to the nearest minute —
    /// what the confirmation shows ("7 小時 12 分").
    public static func hoursAndMinutes(_ seconds: Double) -> (hours: Int, minutes: Int) {
        let totalMinutes = Int((max(0, seconds) / 60).rounded())
        return (totalMinutes / 60, totalMinutes % 60)
    }
}
