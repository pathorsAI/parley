import CoreGraphics

/// Whether a finished drag on the Library switches folder, and which way.
///
/// The rule the founder set: a horizontal swipe that starts on a recording row
/// is the row's (leading download, trailing delete); one that starts anywhere
/// else on the page — the blank area under the last row, the gaps between
/// rows, the folder chips, the empty state — moves to the neighbouring folder.
/// The Library reads the drag without claiming it, so this is the whole
/// decision. Every frame is in the one coordinate space the drag was measured
/// in.
public enum FolderSwipe {
    /// A thumb resting on the glass and drifting does nothing.
    public static let minimumDistance: CGFloat = 60
    /// How much more horizontal than vertical a drag has to be. A flick that is
    /// mostly down with some sideways in it is a scroll of the list, and at
    /// 1:1 a fair share of those would have switched folder instead.
    public static let dominance: CGFloat = 1.5

    /// +1 for the next folder (a leftward swipe), -1 for the previous one
    /// (rightward), nil when the drag is not a folder swipe.
    ///
    /// - Parameters:
    ///   - start: where the finger went down.
    ///   - translation: where it ended, relative to `start`.
    ///   - rows: the recording rows on screen. Only their vertical extent
    ///     counts: a row runs the width of the list, and by the time the drag
    ///     ends its own swipe has slid it sideways, so its frame no longer
    ///     covers the point the finger went down on.
    ///   - list: the list's visible bounds. A row scrolled up under the chips
    ///     still reports its frame, but nothing of it is there to touch.
    ///   - scrollingStrip: a strip that scrolls horizontally on its own (the
    ///     folder chips once they overflow). A drag started there is that
    ///     strip's scroll, not a folder switch. nil when there is none.
    public static func step(
        start: CGPoint, translation: CGSize,
        rows: some Sequence<CGRect>, list: CGRect, scrollingStrip: CGRect? = nil
    ) -> Int? {
        let dx = translation.width
        guard abs(dx) >= minimumDistance,
            abs(dx) > abs(translation.height) * dominance
        else { return nil }
        if let scrollingStrip, scrollingStrip.contains(start) { return nil }
        let onRow =
            list.contains(start)
            && rows.contains { start.y >= $0.minY && start.y < $0.maxY }
        if onRow { return nil }
        return dx < 0 ? 1 : -1
    }
}
