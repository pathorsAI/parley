import Darwin
import Foundation

/// How the keyboard's word tables read their bundled text files: one line at a
/// time, straight off a memory-mapped file, so a parse never holds the file as
/// a string or its lines as an array.
///
/// That is the whole point of it. The tables are built inside a keyboard
/// extension, which iOS jetsams at a limit far below an app's and without a
/// crash log, and what used to set the process's high-water mark was not the
/// table a parse builds but everything it built on the way: the 1.7 MB phrase
/// file decoded into a `String`, then `split` into 61,000 `Substring`s (another
/// 2 MB of array), then an array of every row, then the buckets copied out of
/// it. A mapped file's pages are clean and file-backed, so they are not part of
/// the footprint jetsam counts, and a line handed to the caller is the only
/// thing a line costs — a short string that is freed before the next one is
/// read, so the allocator reuses the same block all the way down the file.
enum ResourceLines {
    /// Call `body` with every line of the file that is neither empty nor a `#`
    /// comment, in file order, without its `\n`. `false` when the file cannot
    /// be read, which the tables treat as "this half answers nothing".
    ///
    /// Lines are decoded as UTF-8, with an invalid sequence repaired rather than
    /// failing the file — the resources are generated and always valid, and a
    /// keyboard that dropped a whole table over one bad byte would be worse.
    @discardableResult
    static func forEach(in url: URL, _ body: (String) -> Void) -> Bool {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else { return false }
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let base = bytes.baseAddress else { return }
            let count = bytes.count
            var start = 0
            while start < count {
                let newline = memchr(base + start, 0x0A, count - start)
                let end = newline.map { UnsafeRawPointer($0) - base } ?? count
                // `#` opens a comment line; an empty line is skipped, as
                // `split(omittingEmptySubsequences:)` used to.
                if end > start, bytes[start] != UInt8(ascii: "#") {
                    body(
                        String(
                            decoding: UnsafeRawBufferPointer(rebasing: bytes[start..<end]),
                            as: UTF8.self))
                }
                start = end + 1
            }
        }
        return true
    }

    /// Ask the allocator to give back the pages a parse freed.
    ///
    /// A parse frees far more than it keeps — the design doc's figure was 12.6 MB
    /// of footprint to build the phrase index against about 3 MB retained, the
    /// rest being the file and its split lines, "freed but whose pages stay".
    /// Freed-but-resident is still footprint as far as jetsam is concerned, so
    /// once a table is built this asks for those pages back. It is best effort:
    /// measured on macOS 26.2 the default zone reported nothing to give back —
    /// that allocator defers reclaiming freed pages to the kernel — which is why
    /// the parse itself was changed to free less in the first place (see
    /// `forEach(in:_:)`). Cheap either way: it walks the allocator's free lists
    /// once, after a parse that happens once per process at most.
    static func returnFreedPages() {
        malloc_zone_pressure_relief(nil, 0)
    }
}
